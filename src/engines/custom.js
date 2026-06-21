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
import { writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveCommand, buildSpawnSpec } from '../env.js';
import { isProEntitled } from '../entitlement.js';
import { handleMessage } from './claude.js';

// Write base64 data-URL images to temp files so a custom CLI can take them via
// its configured `imageArg` template (e.g. "-i {path}", "@{path}"). Returns paths.
async function writeImages(images, tag) {
  const files = [];
  for (let i = 0; i < (images?.length || 0); i++) {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(images[i]?.dataUrl || '');
    if (!m) continue;
    const ext = (m[1].split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'png';
    const file = path.join(os.tmpdir(), `chatpanel-custom-img-${tag}-${i}.${ext}`);
    await writeFile(file, Buffer.from(m[2], 'base64'));
    files.push(file);
  }
  return files;
}

// Expand the user's `imageArg` template across the image files into argv tokens.
// "{path}" is substituted per image; a template without it appends the path.
function imageTokensFor(imageArg, files) {
  const tmpl = String(imageArg || '').trim();
  if (!tmpl || !files.length) return [];
  const tokens = [];
  for (const f of files) {
    tokens.push(
      ...(tmpl.includes('{path}')
        ? tmpl.replaceAll('{path}', f).split(/\s+/).filter(Boolean)
        : [...tmpl.split(/\s+/).filter(Boolean), f]),
    );
  }
  return tokens;
}

// Idle timeout: re-armed on every stdout/stderr chunk, so a long run that keeps
// streaming never trips it — only true silence does. Override with
// CHATPANEL_CUSTOM_TIMEOUT_MS (ms).
const IDLE_MS = Number(process.env.CHATPANEL_CUSTOM_TIMEOUT_MS) || 180_000;

export async function available() {
  // The engine ships in every bridge; individual custom agents are user-defined
  // (Pro) and validated per request and via /agent-check.
  return { ok: true };
}

// Parse a CLI's "list models" stdout into model ids. Tools format this very
// differently (one-per-line, a table, "provider/model", …), so this is
// best-effort: take the first token of each line that looks like an id and skip
// obvious headers/prose. The picker always allows a custom value as a fallback.
function parseModelList(stdout) {
  const out = [];
  const seen = new Set();
  for (const raw of String(stdout || '').split('\n')) {
    const tok = raw.trim().split(/\s+/)[0] || '';
    if (!/^[A-Za-z0-9][\w./:-]{1,79}$/.test(tok)) continue;
    if (/^(name|model|models|id|provider|available|usage|options|commands)$/i.test(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= 200) break;
  }
  return out;
}

// Unified model listing: run the agent's CONFIGURED list-models invocation
// (e.g. pi `--list-models`, opencode `models`) and parse the output. Returns []
// when not configured. Pro-gated like chat (it runs the user's CLI).
export async function listModels(options = {}) {
  if (!(await isProEntitled(options.entitlement))) {
    throw new Error('Custom agents require ChatPanel Pro.');
  }
  const spec = options.custom || {};
  const listArgs = String(spec.listModelsArgs || '').trim();
  if (!spec.command || !listArgs) return [];
  const resolved = resolveCommand(spec.command);
  if (!resolved) throw new Error(`Couldn't find "${spec.command}".`);
  const cwd = options.workingDir ? path.resolve(options.workingDir) : null;
  const [bin, argv, opts] = buildSpawnSpec(resolved, listArgs.split(/\s+/).filter(Boolean), cwd);
  const stdout = await new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, argv, opts); } catch (e) { return reject(new Error(`Failed to start ${spec.command}: ${e.message}`)); }
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Listing models timed out.')); }, 20000);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`Failed to start ${spec.command}: ${e.message}`)); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
    try { child.stdin.end(); } catch { /* some CLIs don't read stdin */ }
  });
  return parseModelList(stdout);
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
  // Inject the selected model via the agent's CONFIGURED model-arg template
  // (e.g. "--model {model}" or, for opencode, "-m {model}" with provider/model).
  // Without a template we can't know how this CLI takes a model, so options.model
  // is ignored — preserving back-compat with agents that bake the model into args.
  if (options.model && spec.modelArg) {
    const tmpl = String(spec.modelArg);
    const injected = tmpl.includes('{model}')
      ? tmpl.replaceAll('{model}', options.model).split(/\s+/).filter(Boolean)
      : [...tmpl.split(/\s+/).filter(Boolean), options.model];
    args = [...injected, ...args];
  }
  // Images: write to temp files, expand the agent's imageArg template, then place
  // the tokens. An explicit {images} placeholder in args wins; otherwise they go
  // just before the prompt (arg mode) or get appended (stdin mode).
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const imageFiles = spec.imageArg ? await writeImages(images, tag) : [];
  const cleanup = () => imageFiles.forEach((f) => unlink(f).catch(() => {}));
  const imageTokens = imageTokensFor(spec.imageArg, imageFiles);
  let placedImages = false;
  if (imageTokens.length) {
    args = args.flatMap((a) => {
      if (a === '{images}') {
        placedImages = true;
        return imageTokens;
      }
      return [a];
    });
  }

  if (promptVia === 'arg') {
    let placed = false;
    args = args.map((a) => {
      if (a.includes('{prompt}')) {
        placed = true;
        return a.replaceAll('{prompt}', prompt);
      }
      return a;
    });
    if (!placed) {
      if (imageTokens.length && !placedImages) args.push(...imageTokens); // images, then prompt
      args.push(prompt);
    }
  } else if (imageTokens.length && !placedImages) {
    args.push(...imageTokens); // stdin prompt: image tokens go on argv
  }

  const [bin, argv, opts] = buildSpawnSpec(resolved, args, cwd);

  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, argv, opts);
    } catch (e) {
      cleanup();
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
        cleanup();
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
      cleanup();
      reject(new Error(`Failed to start ${label}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(idleTimer);
      cleanup();
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
