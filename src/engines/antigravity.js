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

const IDLE_MS = Number(process.env.CHATPANEL_AGY_TIMEOUT_MS) || 180_000;
const SCRATCH = path.join(os.tmpdir(), 'chatpanel-agy-scratch');

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

let installed = false;
let lastProbe = 0;
export async function available() {
  // Cache a positive result; keep re-probing (throttled) while not found so it
  // self-heals once agy appears on PATH — never cache a negative forever.
  if (!installed && Date.now() - lastProbe > 4000) {
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

// The bridge is stateless, so replay the conversation as a single prompt.
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

export async function chat({ messages, system, options, images }, emit) {
  try {
    mkdirSync(SCRATCH, { recursive: true });
  } catch {
    /* best effort */
  }
  const cwd = options.workingDir ? path.resolve(options.workingDir) : SCRATCH;

  // Images: write into the cwd (workspace) and reference with `@<file>` — agy
  // reads @-referenced files (incl. images) inline as multimodal input, so no
  // read-tool approval is needed in headless `-p` mode. (Confirmed working.)
  const imageFiles = writeImages(images, cwd);
  const cleanup = () => imageFiles.forEach((f) => { try { unlinkSync(f); } catch { /* gone */ } });
  let prompt = buildPrompt(messages, system);
  if (imageFiles.length) {
    prompt += `\n\nThe user attached image(s): ${imageFiles.map((f) => '@' + path.basename(f)).join(' ')}`;
  }

  // `-p` runs one prompt non-interactively. --model picks the model.
  // --dangerously-skip-permissions auto-approves tool use (headless has no human
  // approver) only when the user opted into bypassPermissions.
  const args = ['-p', prompt];
  if (options.model) args.push('--model', options.model);
  if (options.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');

  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('agy', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    } catch (e) {
      cleanup();
      return reject(new Error(`Failed to start agy: ${e.message}`));
    }

    let out = '';
    let err = '';
    let streamed = false;
    let idleTimer;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill('SIGKILL');
        cleanup();
        reject(new Error(`Antigravity timed out — no output for ${Math.round(IDLE_MS / 1000)}s.`));
      }, IDLE_MS);
    };
    armIdle();

    child.stdout.on('data', (d) => {
      armIdle();
      const s = d.toString();
      out += s;
      streamed = true;
      emit({ type: 'delta', text: s });
    });
    child.stderr.on('data', (d) => { armIdle(); err += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(idleTimer);
      cleanup();
      reject(new Error(`Failed to start agy: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(idleTimer);
      cleanup();
      if (code === 0) {
        if (!streamed) emit({ type: 'delta', text: out.trim() || '(no output)' });
        emit({ type: 'done', text: '' });
        resolve();
      } else {
        reject(new Error(`Antigravity exited ${code}: ${err.trim() || out.trim() || 'failed'}`));
      }
    });
  });
}
