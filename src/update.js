// In-app updater for the standalone binary.
//
// The bridge is a background service the user never opens, so the EXTENSION
// surfaces "update available" (from /health) and offers a one-click Update that
// calls POST /update. The bridge downloads the new binary, swaps it in, and the
// service relaunches into the new version.
//
// Cross-platform swap + relaunch (users come from anywhere):
//   • macOS  — atomic rename over the running file; KeepAlive relaunches on exit.
//   • Linux  — atomic rename; `systemctl --user restart` relaunches.
//   • Windows — can't overwrite a running .exe, so we RENAME the running exe aside
//               and drop the new one in its place, then a detached helper waits for
//               this process to exit (freeing the port) and relaunches it.
//
// No-ops for npx/node installs — npm owns those; only compiled binaries self-update.

import os from 'node:os';
import path from 'node:path';
import { chmod, rename, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isCompiledBinary } from './env.js';

const REPO = 'chatpanel/chatpanel-bridge';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // 6h
const CACHE = path.join(os.homedir(), '.chatpanel', 'update-check.json');
const UA = { 'User-Agent': 'chatpanel-bridge-updater' };

// Release asset name for THIS platform (matches release-binaries.yml outputs).
// macOS publishes arm64 only; Intel Macs use `npx` (managed → no self-update).
function assetName() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'chatpanel-bridge-macos-arm64' : null;
  if (process.platform === 'linux') return 'chatpanel-bridge-linux-x64';
  if (process.platform === 'win32') return 'chatpanel-bridge-windows-x64.exe';
  return null;
}

function parseVersion(s = '') {
  const m = /(\d+(?:\.\d+){0,3})/.exec(s || '');
  return m ? m[1] : null;
}
// >0 if a is newer than b.
function cmp(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function readCache() {
  try {
    return JSON.parse(await readFile(CACHE, 'utf8'));
  } catch {
    return null;
  }
}
async function writeCache(obj) {
  try {
    await mkdir(path.dirname(CACHE), { recursive: true });
    await writeFile(CACHE, JSON.stringify(obj));
  } catch {
    /* best effort */
  }
}

// Returns { current, latest, updateAvailable, mode, canSelfUpdate, assetUrl, npmCommand }.
//   mode 'binary' → compiled standalone build (macOS/Linux curl install, or the
//                   optional Windows .exe). POST /update self-replaces in place.
//   mode 'npm'    → npx/node install (the default on Windows). The bridge can't
//                   swap its own files; the extension shows `npmCommand` instead.
// Both report updateAvailable so the user always gets the notice — only the action
// differs. Throttled to CHECK_EVERY_MS unless `force`.
export async function checkForUpdate(current, { force = false } = {}) {
  const mode = isCompiledBinary() ? 'binary' : 'npm';
  const want = assetName();

  let latest = null;
  let assetUrl = null;
  const cache = await readCache();
  if (!force && cache && Date.now() - cache.checkedAt < CHECK_EVERY_MS) {
    latest = cache.latest;
    assetUrl = cache.assetUrl;
  } else {
    try {
      const res = await fetch(LATEST_API, { headers: { Accept: 'application/vnd.github+json', ...UA } });
      if (res.ok) {
        const data = await res.json();
        latest = parseVersion(data.tag_name) || parseVersion(data.name);
        assetUrl = want ? (data.assets || []).find((a) => a.name === want)?.browser_download_url || null : null;
        await writeCache({ checkedAt: Date.now(), latest, assetUrl });
      } else {
        latest = cache?.latest || null;
        assetUrl = cache?.assetUrl || null;
      }
    } catch {
      latest = cache?.latest || null;
      assetUrl = cache?.assetUrl || null;
    }
  }
  const updateAvailable = !!latest && cmp(latest, current) > 0;
  // One-click in-place update is only possible for a compiled binary with a
  // matching release asset; npm installs update via the command.
  const canSelfUpdate = mode === 'binary' && !!assetUrl;
  return {
    current,
    latest,
    updateAvailable,
    mode,
    canSelfUpdate,
    assetUrl,
    npmCommand: mode === 'npm' ? 'npm i -g @chatpanel/bridge@latest' : null,
  };
}

// Download the latest binary and swap it in. Does NOT restart — the caller sends
// its HTTP response first, then triggers restartService(). Throws on any failure,
// leaving the running binary untouched.
export async function selfUpdate(current) {
  if (!isCompiledBinary()) {
    throw new Error('Self-update applies only to the standalone binary. Update the npm/npx version with npm.');
  }
  const info = await checkForUpdate(current, { force: true });
  if (!info.assetUrl) throw new Error('No downloadable build for this platform — use `npx @chatpanel/bridge`.');
  if (!info.updateAvailable) {
    throw new Error(info.latest ? `Already on the latest version (v${current}).` : 'Could not reach the update server.');
  }

  const target = process.execPath; // the running binary's own path
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.chatpanel-bridge.new-${Date.now()}`);

  const res = await fetch(info.assetUrl, { headers: UA });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error('Downloaded file looks too small — aborting to avoid a broken bridge.');

  await writeFile(tmp, buf);
  if (process.platform !== 'win32') await chmod(tmp, 0o755);

  if (process.platform === 'win32') {
    // A running .exe can't be overwritten, but it CAN be renamed. Move it aside,
    // drop the new one in place; the old (renamed) file is cleaned up after exit.
    const aside = path.join(dir, `chatpanel-bridge.old-${Date.now()}.exe`);
    await rename(target, aside);
    await rename(tmp, target);
  } else {
    // POSIX: atomic rename over the running file. The live process keeps the old
    // inode; the path now points at the new binary.
    await rename(tmp, target);
  }
  return { ok: true, from: current, to: info.latest };
}
