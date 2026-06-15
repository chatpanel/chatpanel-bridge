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
import { readFile, unlink } from 'node:fs/promises';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findAgentBin } from '../env.js';

const TIMEOUT_MS = Number(process.env.CHATPANEL_CODEX_TIMEOUT_MS) || 180_000;
const REASONING = process.env.CHATPANEL_CODEX_EFFORT ?? 'low'; // '' → respect config

const SCRATCH = path.join(os.tmpdir(), 'chatpanel-codex-scratch');
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

export async function chat({ messages, system, options }, emit) {
  ensureScratch();
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const outFile = path.join(os.tmpdir(), `chatpanel-codex-${tag}.txt`);

  const cwd = options.workingDir ? path.resolve(options.workingDir) : SCRATCH;
  const sandbox =
    options.permissionMode === 'bypassPermissions'
      ? 'danger-full-access'
      : options.permissionMode === 'acceptEdits'
        ? 'workspace-write'
        : 'read-only';

  const args = ['exec', '--json', '--skip-git-repo-check', '-s', sandbox, '-o', outFile];
  // Headless exec has no human to approve commands. Auto-run within the sandbox
  // so skill/startup reads don't get "approval declined" (and skills can load in
  // local-config mode). The sandbox above still bounds what can actually happen.
  args.push('-c', 'approval_policy=never');
  if (REASONING) args.push('-c', `model_reasoning_effort=${REASONING}`);
  if (options.model) args.push('-m', options.model);
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
      return reject(new Error(`Failed to start codex: ${e.message}`));
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Codex timed out after ${Math.round(TIMEOUT_MS / 1000)}s.`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => {
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
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      let text = '';
      try {
        text = (await readFile(outFile, 'utf8')).trim();
      } catch {
        /* no message file */
      }
      unlink(outFile).catch(() => {});
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
