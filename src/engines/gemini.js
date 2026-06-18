// Gemini engine — drives the Gemini CLI (`gemini -p`) using your local login.
//
// Like the Codex engine, this shells out to the installed `gemini` binary in
// non-interactive mode: `gemini -p "<prompt>"` runs once, prints the answer to
// stdout, and exits. We run in an empty scratch dir for general chat so Gemini
// never crawls the bridge's own files; set a working dir on the agent to point
// it at a real project.
//
// Install: `npm i -g @google/gemini-cli`, then run `gemini` once to sign in.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findAgentBin } from '../env.js';

// Idle timeout: re-armed on every stdout/stderr chunk, so a long run that keeps
// streaming never trips it — only true silence does. Override with
// CHATPANEL_GEMINI_TIMEOUT_MS (ms).
const IDLE_MS = Number(process.env.CHATPANEL_GEMINI_TIMEOUT_MS) || 180_000;
const SCRATCH = path.join(os.tmpdir(), 'chatpanel-gemini-scratch');

let installed = false;
let lastProbe = 0;
export async function available() {
  // Cache a positive result, but keep re-probing (throttled) while not found, so
  // it self-heals once gemini appears on PATH — never cache a negative forever.
  if (!installed && Date.now() - lastProbe > 4000) {
    lastProbe = Date.now();
    try {
      installed = !!findAgentBin('gemini');
    } catch {
      installed = false;
    }
  }
  return installed
    ? { ok: true }
    : { ok: false, reason: 'gemini not found on PATH. Install @google/gemini-cli, then run `gemini` once to sign in.' };
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
  try {
    mkdirSync(SCRATCH, { recursive: true });
  } catch {
    /* best effort */
  }
  const cwd = options.workingDir ? path.resolve(options.workingDir) : SCRATCH;

  // `-p` is non-interactive (no TTY prompts). `-m` picks the model. `-y` (yolo)
  // auto-approves tool calls when the user opted into bypassPermissions — without
  // it Gemini would block on an approval it can't show in a headless run.
  const args = ['-p', buildPrompt(messages, system)];
  if (options.model) args.push('-m', options.model);
  if (options.permissionMode === 'bypassPermissions') args.push('-y');

  await new Promise((resolve, reject) => {
    let child;
    try {
      // stdin ignored: the prompt is passed via -p, and no TTY means no
      // interactive "trust this folder?" dialog can block us.
      child = spawn('gemini', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    } catch (e) {
      return reject(new Error(`Failed to start gemini: ${e.message}`));
    }

    let out = '';
    let err = '';
    let streamed = false;
    let idleTimer;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Gemini timed out — no output for ${Math.round(IDLE_MS / 1000)}s.`));
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
      reject(new Error(`Failed to start gemini: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(idleTimer);
      if (code === 0) {
        if (!streamed) emit({ type: 'delta', text: out.trim() || '(no output)' });
        emit({ type: 'done', text: '' });
        resolve();
      } else {
        reject(new Error(`Gemini exited ${code}: ${err.trim() || out.trim() || 'failed'}`));
      }
    });
  });
}
