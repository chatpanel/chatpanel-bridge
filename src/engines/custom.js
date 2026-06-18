// Custom ("bring your own") engine — runs ANY CLI the user onboards from the
// extension's Agents settings (opencode, pi, ollama, a shell script, …) WITHOUT
// a bridge code change per tool. The command spec travels in the chat request's
// `options.custom`; this engine resolves the command cross-platform (PATH /
// Windows cli.js+.cmd / WSL — same launcher as Claude), pipes the prompt in, and
// streams output back.
//
// HARD Pro gate: a custom agent only runs if the request carries a valid,
// server-signed entitlement token (verified OFFLINE here — no network). A forked
// client or a raw POST can't forge it, so this is real gating, not UI.
//
// Output formats:
//   'text' (default) — stream stdout straight through as text deltas. Works for
//                      any program that prints a reply.
//   'claude-stream-json' — parse Claude Code-style stream-json (for tools that
//                      speak it), reusing the Claude engine's parser.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveCommand, buildSpawnSpec } from '../env.js';
import { isProEntitled } from '../entitlement.js';
import { handleMessage } from './claude.js';

// Idle timeout: re-armed on every stdout/stderr chunk, so a long run that keeps
// streaming never trips it — only true silence does. Override with
// CHATPANEL_CUSTOM_TIMEOUT_MS (ms).
const IDLE_MS = Number(process.env.CHATPANEL_CUSTOM_TIMEOUT_MS) || 180_000;

export async function available() {
  // The engine ships in every bridge; individual custom agents are user-defined
  // (Pro) and validated per request and via /agent-check.
  return { ok: true };
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

export async function chat({ messages, system, options }, emit) {
  // Pro gate — verified, not just UI. No valid signed entitlement → no run.
  if (!(await isProEntitled(options.entitlement))) {
    throw new Error('Custom agents require ChatPanel Pro. Upgrade in Settings to bring your own CLI agent.');
  }

  const spec = options.custom || {};
  if (!spec.command) throw new Error('This custom agent has no command configured.');

  const resolved = resolveCommand(spec.command);
  if (!resolved) {
    throw new Error(`Couldn't find "${spec.command}". Enter its full path, or install it on your PATH (or in WSL).`);
  }

  const prompt = buildPrompt(messages, system);
  const cwd = options.workingDir ? path.resolve(options.workingDir) : null;
  const label = spec.label || spec.command;
  const fmt = spec.format === 'claude-stream-json' ? 'claude-stream-json' : 'text';

  // Args: either a real array or a space-split string. With promptVia:'arg' we
  // substitute {prompt} (or append it if there's no placeholder); otherwise the
  // prompt goes in on stdin.
  const promptVia = spec.promptVia === 'arg' ? 'arg' : 'stdin';
  let args = Array.isArray(spec.args)
    ? spec.args.slice()
    : spec.args
      ? String(spec.args).split(/\s+/).filter(Boolean)
      : [];
  if (promptVia === 'arg') {
    let placed = false;
    args = args.map((a) => {
      if (a.includes('{prompt}')) {
        placed = true;
        return a.replaceAll('{prompt}', prompt);
      }
      return a;
    });
    if (!placed) args.push(prompt);
  }

  const [bin, argv, opts] = buildSpawnSpec(resolved, args, cwd);

  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, argv, opts);
    } catch (e) {
      return reject(new Error(`Failed to start ${label}: ${e.message}`));
    }

    let stderr = '';
    let streamedAny = false;
    let resultText = '';
    let jsonBuf = '';

    let idleTimer;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${label} timed out — no output for ${Math.round(IDLE_MS / 1000)}s.`));
      }, IDLE_MS);
    };
    armIdle();

    child.stdout.on('data', (d) => {
      armIdle();
      const s = d.toString();
      if (fmt === 'claude-stream-json') {
        jsonBuf += s;
        let nl;
        while ((nl = jsonBuf.indexOf('\n')) >= 0) {
          const line = jsonBuf.slice(0, nl).trim();
          jsonBuf = jsonBuf.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          const r = handleMessage(msg, emit, streamedAny);
          if (r.streamed) streamedAny = true;
          if (r.result != null) resultText = r.result;
        }
      } else {
        streamedAny = true;
        emit({ type: 'delta', text: s });
      }
    });
    child.stderr.on('data', (d) => { armIdle(); stderr += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(idleTimer);
      reject(new Error(`Failed to start ${label}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(idleTimer);
      if (code === 0) {
        emit({ type: 'done', text: streamedAny ? '' : resultText });
        resolve();
      } else {
        reject(new Error(`${label} exited ${code}: ${stderr.trim().split('\n').pop() || 'failed'}`));
      }
    });

    if (promptVia === 'stdin') child.stdin.write(prompt);
    child.stdin.end();
  });
}
