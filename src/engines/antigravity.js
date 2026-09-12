// Antigravity engine — drives the Antigravity CLI (`agy -p`) using your local
// login. This replaces Gemini CLI as the default Google-model agent (the Gemini
// CLI is being deprecated for individual users).
//
//   agy -p "<prompt>"   → run one prompt non-interactively, print the answer, exit
//   agy --model <id>    → pick the model      agy models → list models
//
// Images: Antigravity has no image flag, but it READS image files referenced by
// path in the prompt (vision) — same approach as Claude Code. We write the image
// into the workspace (cwd), grant read access with --add-dir, and reference the
// path so the model opens it.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findAgentBin } from '../env.js';
import { buildCliPrompt } from './prompt.js';
import { summarizeCliError } from '../cli-errors.js';
import { killOnAbort, spawnGroupOpts } from '../proc.js';
import { pushExtraArgs, FORBIDDEN } from './args.js';
import { resolveWorkdir } from '../workdir.js';

const IDLE_MS = Number(process.env.CHATPANEL_AGY_TIMEOUT_MS) || 180_000;

// `agy models` lists available models. Parse ids best-effort; free text is still
// accepted by the picker, and [] just means "type a model or use the default".
export async function listModels() {
  try {
    const bin = findAgentBin('agy') || 'agy';
    const r = spawnSync(bin, ['models'], { encoding: 'utf8', timeout: 15000 });
    const ids = [];
    const seen = new Set();
    for (const line of String(r.stdout || '').split('\n')) {
      const tok = line.trim().split(/\s+/)[0] || '';
      if (!/^[A-Za-z0-9][\w./:-]{1,79}$/.test(tok)) continue;
      if (/^(name|model|models|id|provider|available)$/i.test(tok)) continue;
      if (seen.has(tok)) continue;
      seen.add(tok);
      ids.push(tok);
      if (ids.length >= 100) break;
    }
    return ids;
  } catch {
    return [];
  }
}

export const newAgyState = () => ({ started: new Set(), finalText: '' });

// Translate one `agy --output-format stream-json` line into the bridge's streaming
// vocabulary. Schema, captured from agy 1.2.2:
//   {event:'init', init:{cwd, tools:[…]}}
//   {event:'step_update', step_update:{ step_index, state:'ACTIVE'|'DONE',
//       step_type:'user_input'|'agent_response'|'tool', text_delta?, tool_name?,
//       tool_info:{ name, parameters, output? }, usage? }}
//   {event:'result', result:{ status:'SUCCESS', response, usage }}
// Returns { streamed } — whether a piece of the ANSWER went out (tool activity does not
// count, so a run that only ran tools still gets its final text from `result`).
export function forwardAgyLine(line, emit, state = newAgyState()) {
  const t = String(line || '').trim();
  if (!t) return { streamed: false };
  let ev;
  try { ev = JSON.parse(t); } catch {
    // Not JSON: the CLI printed something for a human (a warning, a banner). Show it.
    emit({ type: 'delta', text: `${t}\n` });
    return { streamed: true };
  }
  const kind = ev.event || ev.type || '';
  if (kind === 'init') { emit({ type: 'status', text: 'Antigravity working' }); return { streamed: false }; }
  if (kind === 'result') {
    const res = ev.result || {};
    state.finalText = typeof res.response === 'string' ? res.response : '';
    if (res.status && res.status !== 'SUCCESS') emit({ type: 'status', text: `Antigravity: ${res.status}` });
    return { streamed: false };
  }
  if (kind !== 'step_update') return { streamed: false };
  const st = ev.step_update || {};
  if (st.step_type === 'tool') {
    const id = `agy_${st.step_index ?? state.started.size}`;
    const info = st.tool_info && typeof st.tool_info === 'object' ? st.tool_info : {};
    const name = st.tool_name || info.name || 'tool';
    if (!state.started.has(id)) {
      state.started.add(id);
      emit({ type: 'tool', name, phase: 'start', callId: id, input: info.parameters && typeof info.parameters === 'object' ? info.parameters : {} });
    }
    if (st.state === 'DONE') {
      const failed = !!info.error || st.state === 'ERROR';
      const output = info.output == null ? '' : typeof info.output === 'string' ? info.output : JSON.stringify(info.output);
      emit({ type: 'tool', name, phase: 'done', callId: id, status: failed ? `error: ${String(info.error || 'failed').slice(0, 80)}` : 'ok', result: String(failed ? info.error || '' : output).slice(0, 4000) });
    }
    return { streamed: false };
  }
  if (st.step_type === 'agent_response' && typeof st.text_delta === 'string' && st.text_delta) {
    emit({ type: 'delta', text: st.text_delta });
    return { streamed: true };
  }
  return { streamed: false };
}

let installed = false;
let lastProbe = 0;
export async function available() {
  // Cache a positive result; keep re-probing (throttled) while not found so it
  // self-heals once agy appears on PATH — never cache a negative forever.
  // Re-probe in both directions (see codex.js): an uninstalled CLI must stop reporting itself
  // available without waiting for a bridge restart.
  if (Date.now() - lastProbe > (installed ? 30_000 : 4000)) {
    lastProbe = Date.now();
    try {
      installed = !!findAgentBin('agy');
    } catch {
      installed = false;
    }
  }
  return installed
    ? { ok: true }
    : { ok: false, reason: 'agy not found on PATH. Install Antigravity, then run `agy` once to sign in.' };
}

function writeImages(images, dir) {
  const files = [];
  for (let i = 0; i < (images?.length || 0); i++) {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(images[i]?.dataUrl || '');
    if (!m) continue;
    const ext = (m[1].split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'png';
    const file = path.join(dir, `chatpanel-img-${Date.now()}-${i}.${ext}`);
    try {
      writeFileSync(file, Buffer.from(m[2], 'base64'));
      files.push(file);
    } catch {
      /* skip unwritable */
    }
  }
  return files;
}

export async function chat({ messages, system, options, images }, emit, { signal } = {}) {
  const cwd = resolveWorkdir(options.workingDir);

  // Images: write into the cwd (workspace) and reference with `@<file>` — agy
  // reads @-referenced files (incl. images) inline as multimodal input, so no
  // read-tool approval is needed in headless `-p` mode. (Confirmed working.)
  const imageFiles = writeImages(images, cwd);
  const cleanup = () => imageFiles.forEach((f) => { try { unlinkSync(f); } catch { /* gone */ } });
  let prompt = buildCliPrompt(messages, system);
  if (imageFiles.length) {
    prompt += `\n\nThe user attached image(s): ${imageFiles.map((f) => '@' + path.basename(f)).join(' ')}`;
  }

  // `-p` runs one prompt non-interactively. --model picks the model.
  // --dangerously-skip-permissions auto-approves tool use (headless has no human
  // approver) only when the user opted into bypassPermissions.
  const baseArgs = ['-p', prompt];
  if (options.model) baseArgs.push('--model', options.model);
  if (options.permissionMode === 'bypassPermissions') baseArgs.push('--dangerously-skip-permissions');
  // Drop caller extras that would auto-approve tools (shared sanitizer).
  pushExtraArgs(baseArgs, options.extraArgs, FORBIDDEN.antigravity, emit);

  // STRUCTURED OUTPUT FIRST. agy 1.2+ streams `--output-format stream-json`: one NDJSON
  // event per line, with every tool step's name, parameters and output. Plain text — which
  // is all this engine ever read — has no tools in it at all, so a turn that ran six
  // commands showed the panel one answer and nothing else. An older agy that does not know
  // the flag exits non-zero naming it; we fall back to text once, out loud.
  const run = (structured) => new Promise((resolve, reject) => {
    const args = structured ? [...baseArgs, '--output-format', 'stream-json'] : baseArgs;
    let child;
    try {
      child = spawn('agy', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env }, ...spawnGroupOpts });
    } catch (e) {
      return reject(new Error(`Failed to start agy: ${e.message}`));
    }

    const detach = killOnAbort(child, signal); // Stop → terminate the agy child

    let out = '';
    let err = '';
    let buf = '';
    let streamed = false;
    const state = newAgyState();
    let idleTimer;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Antigravity timed out — no output for ${Math.round(IDLE_MS / 1000)}s.`));
      }, IDLE_MS);
    };
    armIdle();

    const forward = (line) => {
      const r = forwardAgyLine(line, emit, state);
      if (r.streamed) streamed = true;
    };
    child.stdout.on('data', (d) => {
      armIdle();
      const s = d.toString();
      out += s;
      if (!structured) { streamed = true; emit({ type: 'delta', text: s }); return; }
      buf += s;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        forward(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on('data', (d) => { armIdle(); err += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(idleTimer);
      detach();
      reject(new Error(`Failed to start agy: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(idleTimer);
      detach();
      if (signal?.aborted) { resolve({ code: 0, aborted: true }); return; } // Stop pressed — end quietly
      if (structured && buf.trim()) forward(buf);
      resolve({ code, out, err, streamed, state });
    });
  });

  try {
    let r = await run(true);
    if (r.aborted) return;
    if (r.code !== 0 && !r.streamed && /output-format|unknown flag|flag provided but not defined/i.test(r.err)) {
      emit({ type: 'status', text: 'This Antigravity CLI has no structured output; showing its text only. Update it with `agy update` to see tool activity.' });
      r = await run(false);
      if (r.aborted) return;
    }
    if (r.code !== 0) throw new Error(summarizeCliError('Antigravity', r.code, r.err, r.out));
    if (!r.streamed) emit({ type: 'delta', text: (r.state?.finalText || r.out).trim() || '(no output)' });
    emit({ type: 'done', text: '' });
  } finally {
    cleanup();
  }
}
