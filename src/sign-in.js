// "Not signed in" — the commonest first-run failure, said as an instruction instead of an exit code.
//
// A user installs ChatPanel, picks Claude Code or Codex, and sends a message before they have
// ever signed in to that CLI. The CLI prints one line ("Not logged in · Please run /login"),
// exits 1, and what reached the panel was "Claude Code exited 1" — which reads as a ChatPanel
// bug, and says nothing about the one thing that fixes it. Worse, in stream-json mode Claude
// Code emits that line as an ASSISTANT message, so it could arrive as if it were the answer.
//
// Two halves, one vocabulary:
//   • `signInStatus(agentId, spec)` asks the CLI itself, cheaply, BEFORE a turn is sent —
//     `claude auth status` (JSON, `loggedIn`) and `codex login status` (a line) — so the
//     agent's availability says "not signed in: run …" and the panel shows it up front. Only
//     an answer that clearly says "not signed in" counts; an old CLI without the subcommand,
//     a timeout or anything unreadable is taken as signed in, because the turn itself is the
//     final judge and a wrong "not signed in" would block a working agent.
//   • `loginRequired(text)` recognises the failure in a turn's output; `signInMessage` is
//     the sentence both halves say.
//
// ChatPanel cannot sign in for the user: the login is the CLI's own OAuth flow, in a browser,
// started from a terminal. So the message names the exact command and says to send again.

import { spawn } from 'node:child_process';
import { buildSpawnSpec } from './env.js';

/** How to sign in, per harness — the command a person types. */
export const SIGN_IN_HINTS = Object.freeze({
  claude: 'open a terminal, run `claude`, and type `/login`',
  codex: 'open a terminal and run `codex login`',
  copilot: 'open a terminal, run `copilot`, and type `/login`',
  opencode: 'open a terminal and run `opencode auth login`',
  kiro: 'open a terminal and run `kiro-cli login`',
  hermes: 'open a terminal and run `hermes setup`',
  antigravity: 'open a terminal, run `agy`, and sign in',
  deepseek: 'open a terminal and sign in to the DeepSeek CLI',
  pi: 'open a terminal, run `pi`, and sign in',
});

const LOGIN_RE = /not logged in|please run \/login|authentication_failed|invalid api key(?:\s*·\s*please run)?|please (?:log|sign) ?in|login required|not authenticated|unauthenticated|missing bearer token|no credentials|\b401\b.*unauthori[sz]ed|token (?:has )?expired.*(?:log|sign) ?in|run `?(?:codex|claude) login`?/i;

/** Does this output say the CLI is not signed in? MCP-server auth failures are a different thing and are excluded. */
export function loginRequired(text) {
  const t = String(text || '');
  if (!t) return false;
  if (/\bmcp\b/i.test(t) && !/not logged in|please run \/login|authentication_failed/i.test(t)) return false;
  return LOGIN_RE.test(t);
}

/** The one sentence: what happened, that nothing was sent, what to do, and that ChatPanel cannot do it. */
export function signInMessage(label, agentId) {
  const hint = SIGN_IN_HINTS[agentId] || `sign in to ${label} in your terminal`;
  return `${label} isn't signed in on this machine, so your message was not sent. ChatPanel uses your own ${label} login and can't sign in for you: ${hint}, finish the sign-in in the browser, then send your message again.`;
}

const CHECKS = {
  claude: { args: ['auth', 'status'], read: (out) => { try { const j = JSON.parse(out.slice(out.indexOf('{'))); return typeof j.loggedIn === 'boolean' ? j.loggedIn : null; } catch { return null; } } },
  codex: { args: ['login', 'status'], read: (out) => (/not logged in/i.test(out) ? false : /logged in/i.test(out) ? true : null) },
};

const cache = new Map(); // agentId -> { at, signedIn }
const TTL_MS = 15_000;

/**
 * `true` / `false` when the CLI says so; `null` when it does not have a status command, did
 * not answer in time, or said something unreadable — never a guess. `spec` is the launch spec
 * from resolveCommand (native / script / cmd / wsl), so the check runs the SAME binary a turn
 * would. Cached briefly: /health asks for every agent on every probe.
 */
export async function signInStatus(agentId, spec, { timeoutMs = 5000, now = Date.now(), spawnImpl = spawn } = {}) {
  const check = CHECKS[agentId];
  if (!check || !spec) return null;
  const hit = cache.get(agentId);
  if (hit && now - hit.at < TTL_MS) return hit.signedIn;
  const result = await new Promise((resolve) => {
    let out = '';
    let child;
    try {
      const [bin, argv, opts] = buildSpawnSpec(spec, check.args, process.cwd(), null);
      child = spawnImpl(bin, argv, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return resolve(null); }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(null); }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(t); resolve(null); });
    child.on('close', () => { clearTimeout(t); resolve(check.read(out)); });
  });
  cache.set(agentId, { at: now, signedIn: result });
  return result;
}

/** Forget a cached answer — after a sign-in the next probe should ask again. */
export function resetSignInCache() { cache.clear(); }
