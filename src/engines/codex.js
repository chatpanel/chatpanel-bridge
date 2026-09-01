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
import { killOnAbort, spawnGroupOpts } from '../proc.js';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findAgentBin, selfMcpStdio } from '../env.js';
import { buildCliPrompt } from './prompt.js';
import { pushExtraArgs, FORBIDDEN } from './args.js';
import { resolveWorkdir } from '../workdir.js';
import { summarizeCliError } from '../cli-errors.js';
import { disabledMcpServers, planMcpRetry, quarantine } from '../mcp-quarantine.js';

// Idle timeout: re-armed on every stdout/stderr chunk, so a long run that keeps
// streaming never trips it — only true silence does. Override with
// CHATPANEL_CODEX_TIMEOUT_MS (ms).
const IDLE_MS = Number(process.env.CHATPANEL_CODEX_TIMEOUT_MS) || 180_000;
const REASONING = process.env.CHATPANEL_CODEX_EFFORT ?? 'low'; // '' → respect config


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
  // Availability = "is codex findable on PATH", not "does `codex --version` exit 0" (which
  // fails when the CLI just needs login). Re-probed in BOTH directions: caching a positive
  // forever kept an uninstalled CLI reporting itself available until the bridge restarted.
  if (Date.now() - lastProbe > (installed ? 30_000 : 4000)) {
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

// Which MCP servers this Codex actually has configured.
//
// READ THIS BEFORE TOUCHING codexDisableArgs. `-c mcp_servers.X.enabled=false` for a name
// that is NOT already in config.toml does not disable anything — it DEFINES a new server
// that has no transport, and Codex then refuses to start at all:
//     Error: failed to load bootstrap configuration
//     Caused by: invalid transport in `mcp_servers.does_not_exist`
// So a stale quarantine entry, or a typo in the user's deny list, would break EVERY run —
// strictly worse than the failure this feature exists to fix. We therefore only ever disable
// a server we can see, and a name we cannot see is left alone (a no-op, never a break).
//
// Read from config.toml — instant, and the same source listModels() already reads — rather
// than shelling out to `codex mcp list --json`, which is authoritative but costs ~0.8s on
// every single turn.
export function configuredMcpServers(home) {
  try {
    const cfg = readFileSync(path.join(home, 'config.toml'), 'utf8');
    const names = new Set();
    for (const m of cfg.matchAll(/^\s*\[mcp_servers\.([A-Za-z0-9_-]+)\s*[.\]]/gm)) names.add(m[1]);
    return names;
  } catch {
    return new Set(); // no config (or the isolated home) — there is nothing to disable
  }
}

// Turn off servers from the user's own config.toml for THIS RUN only — never by editing
// their file. Names are validated upstream (mcp-quarantine.js) and filtered against
// configuredMcpServers by the caller, which is what makes it safe to interpolate one into a
// `-c` override key; `-c` is otherwise blocked in extraArgs precisely because it reaches
// config that matters.
export function codexDisableArgs(names = []) {
  return names.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]);
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

// A single `codex exec` attempt. Resolves with how it ended rather than emitting the final
// message itself, so the caller can decide whether the run is worth ATTEMPTING AGAIN — the
// terminal delta/done belongs to whichever attempt actually answered.
function runCodex({ args, cwd, env, prompt, outFile, emit, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('codex', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env, ...spawnGroupOpts });
    } catch (e) {
      return reject(new Error(`Failed to start codex: ${e.message}`));
    }

    const detach = killOnAbort(child, signal); // Stop → SIGTERM/SIGKILL the codex child

    let stdout = '';
    let stderr = '';
    // Retrying is only honest while nothing the user can see has been produced. Status lines
    // are ours and are replaceable; a delta, a tool call or a reasoning summary is not.
    let streamed = false;
    const relay = (ev) => {
      if (ev?.type !== 'status') streamed = true;
      emit(ev);
    };
    // Per-run event state: correlate a command's started/completed events and emit each
    // reasoning summary once (Codex sends the same item id across item.started/updated/completed).
    const evState = { started: new Set(), reasoned: new Set(), n: 0 };
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
          forwardEvent(JSON.parse(line), relay, evState);
        } catch {
          /* not a JSON event line */
        }
      }
    });
    child.stderr.on('data', (d) => { armIdle(); stderr += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(idleTimer);
      detach();
      reject(e);
    });
    child.on('close', async (code) => {
      clearTimeout(idleTimer);
      detach();
      let text = '';
      try {
        text = (await readFile(outFile, 'utf8')).trim();
      } catch {
        /* no message file */
      }
      unlink(outFile).catch(() => {});
      resolve({ code, stderr, text, streamed });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export async function chat({ messages, system, options, images }, emit, { signal } = {}) {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const outFile = path.join(os.tmpdir(), `chatpanel-codex-${tag}.txt`);
  const imageFiles = await writeImages(images, tag);
  const cleanupImages = () => imageFiles.forEach((f) => unlink(f).catch(() => {}));

  const cwd = resolveWorkdir(options.workingDir);
  // Sanitized once, not per attempt — pushExtraArgs emits a status when it drops something,
  // and a retry must not say it twice.
  const extraArgs = [];
  pushExtraArgs(extraArgs, options.extraArgs, FORBIDDEN.codex, emit);

  const buildArgs = (disabled) => {
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
    // Ask Codex to emit reasoning SUMMARIES so the panel can stream the model's thinking.
    // Additive + safe: a no-op for models/providers that don't produce summaries (e.g. some
    // hosted models expose none), and cheap at the default effort. forwardEvent renders them.
    args.push('-c', 'model_reasoning_summary=auto');
    // Browser tools: register the bridge's MCP server as a stdio MCP server (the
    // bridge binary in --mcp-stdio mode), so Codex can call our page-action tools.
    // `-c key=value` parses value as TOML; JSON.stringify yields valid TOML here.
    args.push(...codexMcpConfigArgs(options.mcp));
    // ...and the other direction: the user's own servers we've been told to leave out.
    args.push(...codexDisableArgs(disabled));
    if (options.model) args.push('-m', options.model);
    // Drop caller extras that would re-open the sandbox/approval boundary (shared sanitizer).
    args.push(...extraArgs);
    for (const f of imageFiles) args.push('-i', f); // attach images to the initial prompt
    args.push('-');
    return args;
  };

  // Default: use the user's skills/config. Opt-out → isolated home.
  const useLocal = options.useLocalConfig !== false;
  const env = { ...process.env };
  if (!useLocal) {
    const home = ensureIsolatedHome();
    if (home) env.CODEX_HOME = home;
  }

  const ownServer = options.mcp?.serverName || 'chatpanel_browser';
  // Only servers Codex already knows about can be switched off — see configuredMcpServers.
  const known = configuredMcpServers(env.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  let disabled = disabledMcpServers('codex', options, [ownServer]).filter((n) => known.has(n));
  const prompt = buildCliPrompt(messages, system);
  const attempt = () => runCodex({ args: buildArgs(disabled), cwd, env, prompt, outFile, emit, signal });

  try {
    let result = await attempt();

    // The failure this exists for: one of the user's OWN MCP servers could not authenticate
    // or could not be reached, and took a turn with it that never needed that server. Drop it
    // and run again — once, out loud, and only while nothing has been streamed.
    if (!signal?.aborted && result.code !== 0 && !result.streamed) {
      const drop = planMcpRetry({ agent: 'codex', text: result.stderr, protect: [ownServer], already: disabled });
      if (drop && known.has(drop.server)) {
        quarantine('codex', drop.server);
        emit({ type: 'status', text: `MCP server "${drop.server}" failed to load — ${drop.short}. Skipping it and retrying.` });
        disabled = [...disabled, drop.server];
        result = await attempt();
      }
    }

    if (signal?.aborted) return; // Stop pressed — end quietly, no error
    if (result.code !== 0) throw new Error(summarizeCliError('Codex', result.code, result.stderr));
    emit({ type: 'delta', text: result.text || '(no output)' });
    emit({ type: 'done', text: '' });
  } finally {
    cleanupImages();
  }
}

// Translate Codex `exec --json` events into the bridge's streaming vocabulary the panel
// renders richly. Codex sends item.started (in_progress) then item.completed for each item,
// reusing the item id — so we correlate a tool's start/done by that id and show its command,
// its output, and its exit status, the way Codex's own CLI does. Schema (codex-cli 0.15x):
//   command_execution: { id, command, aggregated_output, exit_code, status }
//   reasoning:         { id, text }            (only some models/efforts emit it)
//   file_change:       { id, changes:[{path}] }
//   agent_message:     { id, text }            (the answer — read from -o outFile at close)
export function forwardEvent(ev, emit, state = { started: new Set(), reasoned: new Set(), n: 0 }) {
  const t = ev.type || '';
  const item = ev.item || {};
  const itype = item.type || '';
  const completed = t === 'item.completed' || item.status === 'completed' || item.status === 'failed';

  if (itype === 'command_execution' || (!itype && t.includes('command'))) {
    const id = item.id || `cmd_${state.n++}`;
    if (!state.started.has(id)) {
      state.started.add(id);
      emit({ type: 'tool', name: 'shell', phase: 'start', callId: id, input: { command: item.command || '' } });
    }
    if (completed) {
      const ok = item.exit_code === 0 || item.exit_code == null;
      emit({
        type: 'tool', name: 'shell', phase: 'done', callId: id,
        status: ok ? 'ok' : `exit ${item.exit_code}`,
        result: String(item.aggregated_output || '').slice(0, 4000),
      });
    }
    return;
  }

  if (itype === 'file_change' || (!itype && t.includes('patch'))) {
    const id = item.id || `edit_${state.n++}`;
    const files = Array.isArray(item.changes) ? item.changes.map((c) => c.path || c.file).filter(Boolean) : [];
    if (!state.started.has(id)) {
      state.started.add(id);
      emit({ type: 'tool', name: 'edit', phase: 'start', callId: id, input: { files } });
    }
    if (completed) emit({ type: 'tool', name: 'edit', phase: 'done', callId: id, status: 'ok' });
    return;
  }

  if (itype === 'reasoning' || (!itype && t.includes('reasoning'))) {
    // Emit each reasoning summary once (dedup the started/updated/completed repeats).
    const id = item.id || `r_${state.n++}`;
    const text = item.text || item.summary || '';
    if (text && !state.reasoned.has(id)) {
      state.reasoned.add(id);
      emit({ type: 'reasoning', text: `${text}\n` });
    }
    return;
  }

  if (t === 'turn.started' || t === 'thread.started') emit({ type: 'status', text: 'Codex working' });
}
