// Resolve a usable PATH for spawning the agent CLIs (codex, gemini).
//
// When the bridge runs as a login service (LaunchAgent / Scheduled Task) — or as
// a double-clicked app — it inherits a MINIMAL PATH, not your interactive shell's.
// So CLIs installed via Homebrew, npm-global, nvm, etc. aren't found. We fix that
// by (1) asking your login shell for its PATH and (2) adding common bin dirs.

import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';

let enriched = false;

// The agent CLIs the bridge shells out to. Claude has its own richer resolution
// (resolveClaude: native / cli.js / WSL / SDK) below.
const AGENT_CLIS = ['codex', 'gemini', 'claude'];

// Is `name` executable somewhere on the current PATH?
function onPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  return dirs.some((d) => d && (existsSync(path.join(d, name)) || existsSync(path.join(d, name + '.exe'))));
}

// Resolve an agent CLI to its absolute path: first on the (enriched) PATH, then
// by asking the login shell. Returns the path, or null. Used for availability —
// "is it installed/findable", NOT "does `--version` exit 0" (which can fail for
// reasons unrelated to installation, e.g. the CLI needs login).
export function findAgentBin(name) {
  // On Windows, CLIs are usually <name>.cmd / .exe / .bat (npm shims).
  const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat', '.ps1'] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of exts) {
      const p = path.join(d, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return shellWhich(name) || null;
}

// True when running as a Bun/Node single-file compiled binary (not under a
// node/bun interpreter). Inside such a binary, bundled JS files live on a virtual
// FS that child processes can't reach — notably the Claude SDK's CLI on Windows.
export function isCompiledBinary() {
  const base = path.basename(process.execPath).toLowerCase();
  return !(base.startsWith('node') || base.startsWith('bun'));
}

// Ask the user's login shell to locate a command — no hardcoded locations, works
// wherever the user actually installed it.
function shellWhich(name) {
  if (process.platform === 'win32') return '';
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const r = spawnSync(shell, ['-ilc', `command -v ${name} 2>/dev/null`], {
      encoding: 'utf8',
      timeout: 4000,
    });
    const out = (r.stdout || '').trim().split('\n').pop().trim();
    return out && out.startsWith('/') ? out : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Claude Code launcher resolution.
//
// The Codex/Gemini engines can assume `spawn('codex', …)` runs a directly
// executable file on the current OS's PATH. Claude needs more care:
//   • On Windows, npm installs `claude.cmd` / `claude.ps1` / an extensionless
//     bash shim — NONE of which Node's spawn() can execute directly (that's the
//     "spawn C:\… ENOENT"). The runnable thing is the package's `cli.js`, which
//     we run with our own Node/Bun.
//   • A very common setup is "Windows host, `claude` only installed inside WSL."
//     A Windows process can't see WSL's filesystem or PATH, so we cross the
//     boundary explicitly via `wsl.exe`.
// On macOS/Linux (and WSL-native Node) none of this applies: we return the same
// native binary the old code spawned, so behavior there is unchanged.
//
// Returns one of:
//   { kind: 'native', bin, shell }   → spawn(bin, args, { shell })
//   { kind: 'script', script }       → spawn(process.execPath, [script, ...args])
//   { kind: 'wsl' }                  → spawn('wsl.exe', [wsl prefix, ...args])
//   null                             → not found (caller may fall back to SDK)
export function resolveClaude() {
  const override = process.env.CHATPANEL_CLAUDE_PATH;
  if (override) {
    const ext = path.extname(override).toLowerCase();
    if (!isCompiledBinary() && /\.(c?js|mjs)$/.test(ext)) return { kind: 'script', script: override };
    return { kind: 'native', bin: override, shell: process.platform === 'win32' && (ext === '.cmd' || ext === '.bat') };
  }

  if (process.platform === 'win32') {
    const win = findClaudeWindows();
    if (win) return win;
    if (claudeInWsl()) return { kind: 'wsl' };
    return null;
  }

  // macOS / Linux / WSL-native: same resolution the engine used before.
  const bin = findAgentBin('claude');
  return bin ? { kind: 'native', bin, shell: false } : null;
}

// Locate a runnable Claude Code on Windows. Prefer the package's cli.js (run
// with our own Node/Bun — clean arg passing, no cmd.exe quoting), then a real
// .exe, then a .cmd shim via the shell as a last resort.
function findClaudeWindows() {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    const hasShim = ['claude', 'claude.cmd', 'claude.exe', 'claude.ps1', 'claude.bat'].some((n) =>
      existsSync(path.join(d, n)),
    );
    if (!hasShim) continue;
    // Running cli.js with our own interpreter only works under a real Node/Bun,
    // not inside a compiled single-file binary (which is not a JS interpreter).
    if (!isCompiledBinary()) {
      const js = claudeCliJs(d);
      if (js) return { kind: 'script', script: js };
    }
    if (existsSync(path.join(d, 'claude.exe'))) return { kind: 'native', bin: path.join(d, 'claude.exe'), shell: false };
    if (existsSync(path.join(d, 'claude.cmd'))) return { kind: 'native', bin: path.join(d, 'claude.cmd'), shell: true };
    if (existsSync(path.join(d, 'claude.bat'))) return { kind: 'native', bin: path.join(d, 'claude.bat'), shell: true };
  }
  return null;
}

// The npm shim sits next to (or one level up from) the claude-code package.
function claudeCliJs(dir) {
  const rels = [
    ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js'],
    ['..', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'],
    ['..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'],
  ];
  for (const r of rels) {
    const c = path.join(dir, ...r);
    if (existsSync(c)) return c;
  }
  return null;
}

// Is `claude` reachable inside the default WSL distro's login shell? Cached;
// re-probed (throttled) while not found so it self-heals once WSL/claude appear.
let wslClaude = null;
let wslProbe = 0;
function claudeInWsl() {
  if (wslClaude === null || (!wslClaude && Date.now() - wslProbe > 4000)) {
    wslProbe = Date.now();
    try {
      const r = spawnSync('wsl.exe', ['-e', 'bash', '-lic', 'command -v claude'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      });
      wslClaude = r.status === 0 && /\S/.test(stripBom(r.stdout || ''));
    } catch {
      wslClaude = false;
    }
  }
  return wslClaude;
}

// Translate a Windows path to its WSL (/mnt/c/…) equivalent. Returns null on
// failure so the caller can just run in WSL's home instead.
export function toWslPath(winPath) {
  try {
    const r = spawnSync('wsl.exe', ['-e', 'wslpath', '-a', winPath], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const out = stripBom(r.stdout || '').trim();
    return out.startsWith('/') ? out : null;
  } catch {
    return null;
  }
}

function stripBom(s) {
  return s.replace(/^﻿/, '').trim();
}

// Version managers install CLIs under versioned bin dirs that a lazy-loaded
// shell (nvm/fnm) doesn't export into a non-interactive service PATH. Add them.
function versionManagerBins(home) {
  const bins = [];
  const tryDir = (dir, sub) => {
    try {
      for (const v of readdirSync(dir)) bins.push(path.join(dir, v, sub));
    } catch {
      /* dir absent */
    }
  };
  // nvm: ~/.nvm/versions/node/<v>/bin
  tryDir(path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node'), 'bin');
  // fnm: ~/.local/share/fnm/node-versions/<v>/installation/bin (+ macOS app-support)
  tryDir(path.join(home, '.local', 'share', 'fnm', 'node-versions'), path.join('installation', 'bin'));
  tryDir(path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), path.join('installation', 'bin'));
  // volta / asdf shims
  bins.push(path.join(home, '.volta', 'bin'));
  bins.push(path.join(home, '.asdf', 'shims'));
  return bins;
}

export function enrichPath() {
  if (enriched || process.platform === 'win32') {
    enriched = true;
    return; // Windows scheduled tasks run as the user and inherit a fuller PATH.
  }
  enriched = true;

  const home = os.homedir();
  const common = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.deno', 'bin'),
    path.join(home, '.bun', 'bin'),
    ...versionManagerBins(home),
  ];

  // Ask the user's login shell for its PATH — captures nvm / Homebrew / asdf, etc.
  let shellPath = '';
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const r = spawnSync(shell, ['-ilc', 'command -p echo "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
    });
    if (r.status === 0) shellPath = (r.stdout || '').trim();
  } catch {
    /* fall back to common dirs below */
  }

  const seen = new Set();
  const merged = [
    ...(shellPath ? shellPath.split(':') : []),
    ...(process.env.PATH ? process.env.PATH.split(path.delimiter) : []),
    ...common,
  ].filter((p) => p && !seen.has(p) && (seen.add(p), true));

  process.env.PATH = merged.join(path.delimiter);

  // Final, hardcode-free backstop: if an agent CLI still isn't on PATH, ask the
  // login shell exactly where it is and prepend that dir. Covers any custom
  // install location (asdf shims, a one-off prefix, etc.).
  for (const cli of AGENT_CLIS) {
    if (onPath(cli)) continue;
    const found = shellWhich(cli);
    if (found) process.env.PATH = path.dirname(found) + path.delimiter + process.env.PATH;
  }
}
