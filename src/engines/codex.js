// Codex engine — drives the Codex CLI (`codex exec`) using your local Codex login.
//
// Two modes, chosen per-agent in ChatPanel Settings ("Use my local skills & config"):
//
//   useLocalConfig: true  (DEFAULT) — your real CODEX_HOME loads, so your skills,
//      MCP servers and config.toml all work. Best for "it should behave like my
//      Codex." Can be slower if your global skills do a lot of work.
//
//   useLocalConfig: false — run against an ISOLATED CODEX_HOME (just a symlink to
//      your auth so you stay logged in). Skips your global AGENTS.md / skills, so
//      it answers fast and never crawls files (~9x faster in practice).
//
// In BOTH modes we run in an EMPTY scratch dir for general chat, so Codex never
// references the bridge's own code or an unrelated project. Set a working dir on
// the agent to point it at a real project.

import { spawn, spawnSync } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findAgentBin, selfMcpStdio } from '../env.js';

// Idle timeout: re-armed on every stdout/stderr chunk, so a long run that keeps
// streaming never trips it — only true silence does. Override with
// CHATPANEL_CODEX_TIMEOUT_MS (ms).
const IDLE_MS = Number(process.env.CHATPANEL_CODEX_TIMEOUT_MS) || 180_000;
const REASONING = process.env.CHATPANEL_CODEX_EFFORT ?? 'low'; // '' → respect config

const SCRATCH = path.join(os.tmpdir(), 'chatpanel-codex-scratch');

// Codex has no "list models" command — its model lives in CODEX_HOME/config.toml
// (e.g. `model = "gpt-5.5"`). Surface the user's REAL configured model(s), read
// straight from that file, plus a few common ids. The picker still accepts any
// free-text value, so an out-of-date curated entry is harmless.
const CODEX_KNOWN = ['gpt-5-codex', 'gpt-5', 'o3', 'o4-mini'];
export async function listModels() {
  const set = new Set();
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const cfg = readFileSync(path.join(home, 'config.toml'), 'utf8');
    for (const m of cfg.matchAll(/(?:^|\n)\s*model\s*=\s*["']([^"'\n]+)["']/g)) set.add(m[1].trim());
  } catch { /* no config — fall back to the curated set */ }
  for (const m of CODEX_KNOWN) set.add(m);
  return [...set];
}
const ISO_HOME = path.join(os.homedir(), '.chatpanel', 'codex-home');

function ensureScratch() {
  try {
    mkdirSync(SCRATCH, { recursive: true });
  } catch {
    /* best effort */
  }
}

// Build (once) an isolated CODEX_HOME that has only a link to your auth, so the
// global skills/config don't load. Returns the path, or null on failure.
let isoReady = false;
function ensureIsolatedHome() {
  if (!isoReady) {
    try {
      mkdirSync(ISO_HOME, { recursive: true });
      const realAuth = path.join(os.homedir(), '.codex', 'auth.json');
      const linkAuth = path.join(ISO_HOME, 'auth.json');
      if (existsSync(realAuth) && !existsSync(linkAuth)) {
        try {
          symlinkSync(realAuth, linkAuth);
        } catch {
          /* auth errors surface clearly downstream */
        }
      }
      isoReady = true;
    } catch {
      return null;
    }
  }
  return ISO_HOME;
}

let installed = false;
let lastProbe = 0;
export async function available() {
  // Availability = "is codex findable on PATH", not "does `codex --version` exit
  // 0" (which fails when the CLI just needs login). Cache positives; re-probe
  // (throttled) while not found so it self-heals once codex appears on PATH.
  if (!installed && Date.now() - lastProbe > 4000) {
    lastProbe = Date.now();
    try {
      installed = !!findAgentBin('codex');
    } catch {
      installed = false;
    }
  }
  return installed
    ? { ok: true }
    : { ok: false, reason: 'codex not found on PATH. Install it and run `codex login`.' };
}

function buildPrompt(messages, system) {
  let p = system ? `${system}\n\n` : '';
  const history = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  if (history.length) {
    p += 'Conversation so far:\n';
    for (const m of history) p += `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}\n\n`;
    p += '---\n\n';
  }
  p += last ? last.content : '';
  return p;
}

export function codexMcpConfigArgs(mcp) {
  if (!mcp?.url) return [];
  const name = mcp.serverName || 'chatpanel_browser';
  const { command, args: pargs } = selfMcpStdio(mcp.url);
  const args = [
    '-c',
    `mcp_servers.${name}.command=${JSON.stringify(command)}`,
    '-c',
    `mcp_servers.${name}.args=${JSON.stringify(pargs)}`,
    '-c',
    `mcp_servers.${name}.default_tools_approval_mode="approve"`,
    '-c',
    `mcp_servers.${name}.startup_timeout_sec=30`,
    '-c',
    `mcp_servers.${name}.tool_timeout_sec=120`,
  ];
  const toolNames = [...new Set((mcp.specs || []).map((s) => s?.name).filter(Boolean))];
  if (toolNames.length) {
    args.push('-c', `mcp_servers.${name}.enabled_tools=${JSON.stringify(toolNames)}`);
  }
  return args;
}

// Write base64 data-URL images to temp files so `codex exec -i <file>` can
// attach them to the prompt as vision input. Returns the paths (caller cleans up).
async function writeImages(images, tag) {
  const files = [];
  for (let i = 0; i < (images?.length || 0); i++) {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(images[i]?.dataUrl || '');
    if (!m) continue;
    const ext = (m[1].split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'png';
    const file = path.join(os.tmpdir(), `chatpanel-codex-img-${tag}-${i}.${ext}`);
    await writeFile(file, Buffer.from(m[2], 'base64'));
    files.push(file);
  }
  return files;
}

export async function chat({ messages, system, options, images }, emit) {
  ensureScratch();
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const outFile = path.join(os.tmpdir(), `chatpanel-codex-${tag}.txt`);
  const imageFiles = await writeImages(images, tag);
  const cleanupImages = () => imageFiles.forEach((f) => unlink(f).catch(() => {}));

  const cwd = options.workingDir ? path.resolve(options.workingDir) : SCRATCH;
  const args = ['exec', '--json', '--skip-git-repo-check', '-o', outFile];
  // Headless exec has no human to approve actions. With MCP/browser tools armed
  // Codex would otherwise raise an approval prompt it can't show — and cancel the
  // tool call. So in bypassPermissions (full autonomy, what "Act on page" needs)
  // use the all-in bypass flag, which also clears MCP-tool approval. Lower modes
  // keep the sandbox + never-ask, which auto-runs within bounds.
  if (options.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    const sandbox = options.permissionMode === 'acceptEdits' ? 'workspace-write' : 'read-only';
    args.push('-s', sandbox, '-c', 'approval_policy=never');
  }
  if (REASONING) args.push('-c', `model_reasoning_effort=${REASONING}`);
  // Browser tools: register the bridge's MCP server as a stdio MCP server (the
  // bridge binary in --mcp-stdio mode), so Codex can call our page-action tools.
  // `-c key=value` parses value as TOML; JSON.stringify yields valid TOML here.
  args.push(...codexMcpConfigArgs(options.mcp));
  if (options.model) args.push('-m', options.model);
  if (options.extraArgs) args.push(...String(options.extraArgs).split(/\s+/).filter(Boolean));
  for (const f of imageFiles) args.push('-i', f); // attach images to the initial prompt
  args.push('-');

  // Default: use the user's skills/config. Opt-out → isolated home.
  const useLocal = options.useLocalConfig !== false;
  const env = { ...process.env };
  if (!useLocal) {
    const home = ensureIsolatedHome();
    if (home) env.CODEX_HOME = home;
  }

  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('codex', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (e) {
      cleanupImages();
      return reject(new Error(`Failed to start codex: ${e.message}`));
    }

    let stdout = '';
    let stderr = '';
    let idleTimer;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Codex timed out — no output for ${Math.round(IDLE_MS / 1000)}s.`));
      }, IDLE_MS);
    };
    armIdle();

    child.stdout.on('data', (d) => {
      armIdle();
      stdout += d.toString();
      let nl;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        try {
          forwardEvent(JSON.parse(line), emit);
        } catch {
          /* not a JSON event line */
        }
      }
    });
    child.stderr.on('data', (d) => { armIdle(); stderr += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(idleTimer);
      cleanupImages();
      reject(e);
    });
    child.on('close', async (code) => {
      clearTimeout(idleTimer);
      let text = '';
      try {
        text = (await readFile(outFile, 'utf8')).trim();
      } catch {
        /* no message file */
      }
      unlink(outFile).catch(() => {});
      cleanupImages();
      if (code === 0) {
        emit({ type: 'delta', text: text || '(no output)' });
        emit({ type: 'done', text: '' });
        resolve();
      } else {
        reject(new Error(`Codex exited ${code}: ${stderr.trim() || 'failed'}`));
      }
    });

    child.stdin.write(buildPrompt(messages, system));
    child.stdin.end();
  });
}

function forwardEvent(ev, emit) {
  const t = ev.type || '';
  const item = ev.item || {};
  if (item.type === 'command_execution' || t.includes('command')) {
    emit({ type: 'tool', name: 'shell', summary: (item.command || '').slice(0, 60) });
  } else if (item.type === 'reasoning' || t.includes('reasoning')) {
    emit({ type: 'reasoning' });
  } else if (item.type === 'file_change' || t.includes('patch')) {
    emit({ type: 'tool', name: 'edit', summary: '' });
  } else if (t === 'turn.started' || t === 'thread.started') {
    emit({ type: 'status', text: 'Codex working' });
  }
}
