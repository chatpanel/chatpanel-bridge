// Resolve a usable PATH for spawning the agent CLIs (codex, agy).
//
// When the bridge runs as a login service (LaunchAgent / Scheduled Task) — or as
// a double-clicked app — it inherits a MINIMAL PATH, not your interactive shell's.
// So CLIs installed via Homebrew, npm-global, nvm, etc. aren't found. We fix that
// by (1) asking your login shell for its PATH and (2) adding common bin dirs.

import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';

let enriched = false;

// The agent CLIs the bridge shells out to. Claude has its own richer resolution
// (resolveClaude: native / cli.js / WSL / SDK) below.
const AGENT_CLIS = ['codex', 'claude', 'agy', 'pi', 'opencode', 'kiro-cli'];

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

// How to re-invoke THIS bridge as a child process running the stdio↔HTTP MCP
// proxy (`--mcp-stdio <url>`). Lets ANY stdio-capable MCP CLI (Codex, a custom
// CLI) reach the bridge's HTTP MCP server using the bridge itself as the server
// command — no extra runtime to install. Compiled binary → the binary; Node →
// node + this entry script. Returns { command, args }.
export function selfMcpStdio(url) {
  const args = ['--mcp-stdio', url];
  if (isCompiledBinary()) return { command: process.execPath, args };
  // Node/Bun: re-run this same entry script (server.js) under the same runtime.
  const entry = process.argv[1] || path.join(process.cwd(), 'src', 'server.js');
  return { command: process.execPath, args: [entry, ...args] };
}

// Ask the user's login shell to locate a command — no hardcoded locations, works
// wherever the user actually installed it.
function shellWhich(name) {
  if (process.platform === 'win32') return '';
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const r = spawnSync(shell, ['-lc', `command -v ${name} 2>/dev/null`], {
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
//   { kind: 'native', bin }          → spawn(bin, args)          (directly exec'able)
//   { kind: 'script', script }       → spawn(process.execPath, [script, ...args])
//   { kind: 'cmd', bin }             → spawn('cmd.exe', ['/c', bin, ...args])
//   { kind: 'wsl' }                  → spawn('wsl.exe', [wsl prefix, ...args])
//   null                             → not found (caller may fall back to SDK)
//
// We never use spawn's `shell: true` — with an args array it concatenates rather
// than escapes (Node DEP0190 / a real injection surface). The 'script' and 'cmd'
// kinds run the shim safely with a proper argv instead.
export function resolveClaude() {
  if (process.env.CHATPANEL_CLAUDE_PATH) return resolveCommand(process.env.CHATPANEL_CLAUDE_PATH);
  // The Claude npm package additionally ships a cli.js we prefer; otherwise this
  // is the same generic resolution every command uses.
  return resolveCommand('claude');
}

// Resolve ANY command (a bare name like `opencode`, or an absolute/relative path)
// to a launch spec, the same way resolveClaude does — so custom user-onboarded
// agents get identical cross-platform launching (PATH, Windows cli.js/.cmd, WSL).
//
// Returns one of:
//   { kind: 'native', bin }              → spawn(bin, args)
//   { kind: 'script', script }           → spawn(process.execPath, [script, ...args])
//   { kind: 'cmd', bin }                 → spawn('cmd.exe', ['/c', bin, ...args])
//   { kind: 'wsl', command }             → spawn('wsl.exe', [prefix, command, ...args])
//   null                                 → not found
//
// We never use spawn's `shell: true` — with an args array it concatenates rather
// than escapes (Node DEP0190 / a real injection surface). The 'script'/'cmd'/'wsl'
// kinds run things safely with a proper argv instead.
export function resolveCommand(command) {
  if (!command) return null;
  const looksLikePath = command.includes('/') || command.includes('\\') || /\.[a-z0-9]+$/i.test(command);

  if (looksLikePath) {
    if (!existsSync(command)) return null; // an explicit path: don't PATH-search
    const ext = path.extname(command).toLowerCase();
    if (!isCompiledBinary() && /^\.(c?js|mjs)$/.test(ext)) return { kind: 'script', script: command };
    if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) return { kind: 'cmd', bin: command };
    return { kind: 'native', bin: command };
  }

  if (process.platform === 'win32') {
    const win = findCommandWindows(command);
    if (win) return win;
    // Common: tool only installed inside WSL. Only probe safe, simple names.
    if (/^[\w.-]+$/.test(command) && commandInWsl(command)) return { kind: 'wsl', command };
    return null;
  }

  const bin = findAgentBin(command);
  return bin ? { kind: 'native', bin } : null;
}

// Locate a runnable command on Windows. Prefer a runnable JS entry (run with our
// own Node/Bun — clean arg passing, no cmd.exe quoting), then a real .exe, then a
// .cmd/.bat shim launched safely via cmd.exe.
function findCommandWindows(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    const exts = ['', '.cmd', '.exe', '.ps1', '.bat'];
    if (!exts.some((e) => existsSync(path.join(d, name + e)))) continue;
    // Running cli.js with our own interpreter only works under a real Node/Bun,
    // not inside a compiled single-file binary (which is not a JS interpreter).
    if (!isCompiledBinary()) {
      const js = (name === 'claude' && claudeCliJs(d)) || shimTarget(d, name);
      if (js) return { kind: 'script', script: js };
    }
    if (existsSync(path.join(d, name + '.exe'))) return { kind: 'native', bin: path.join(d, name + '.exe') };
    if (existsSync(path.join(d, name + '.cmd'))) return { kind: 'cmd', bin: path.join(d, name + '.cmd') };
    if (existsSync(path.join(d, name + '.bat'))) return { kind: 'cmd', bin: path.join(d, name + '.bat') };
  }
  return null;
}

// The Claude npm package additionally ships a cli.js we prefer (static guesses
// before parsing the shim).
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

// Robust, general fallback: every npm/pnpm/yarn/volta shim literally names the JS
// entry it runs, relative to the shim dir (`%dp0%\…\cli.js` in .cmd,
// `$basedir/…/cli.js` in the sh/.ps1 shims). Extract that so any install layout
// resolves to a real JS entry we can run with our own interpreter.
function shimTarget(dir, name) {
  for (const shim of [`${name}.cmd`, name, `${name}.ps1`]) {
    let txt;
    try {
      txt = readFileSync(path.join(dir, shim), 'utf8');
    } catch {
      continue;
    }
    const m = txt.match(/(?:%~?dp0%|\$basedir|\$\{basedir\})[\\/]+([^"'\s]+\.[cm]?js)/i);
    if (m) {
      const abs = path.join(dir, m[1].replace(/[\\/]+/g, path.sep));
      if (existsSync(abs)) return abs;
    }
  }
  return null;
}

// Is `name` reachable inside the default WSL distro's login shell? Cached per
// name; re-probed (throttled) while not found so it self-heals once it appears.
const wslSeen = new Map(); // name -> { ok, at }
function commandInWsl(name) {
  const c = wslSeen.get(name);
  if (c && (c.ok || Date.now() - c.at < 4000)) return c.ok;
  let ok = false;
  try {
    const r = spawnSync('wsl.exe', ['-e', 'bash', '-lic', `command -v ${name}`], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    ok = r.status === 0 && /\S/.test(stripBom(r.stdout || ''));
  } catch {
    ok = false;
  }
  wslSeen.set(name, { ok, at: Date.now() });
  return ok;
}

// Turn a launch spec + CLI args into a concrete [bin, argv, opts] for spawn().
// `cwd` is the resolved working dir (a Windows path on win32), or null for home.
export function buildSpawnSpec(spec, args, cwd) {
  if (spec.kind === 'wsl') {
    // Run inside WSL's login shell so nvm/etc. PATH resolves the tool. The
    // `exec <cmd> "$@"` + 'chatpanel' ($0) trick passes our args through as a
    // proper argv array — no manual quoting, even for multi-line prompts.
    const pre = [];
    if (cwd) {
      const wslCwd = toWslPath(cwd);
      if (wslCwd) pre.push('--cd', wslCwd); // else: run in WSL home
    }
    const argv = [...pre, '-e', 'bash', '-lic', `exec ${spec.command} "$@"`, 'chatpanel', ...args];
    return ['wsl.exe', argv, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true }];
  }
  const opts = { cwd: cwd || os.homedir(), stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true };
  if (spec.kind === 'script') return [process.execPath, [spec.script, ...args], opts];
  if (spec.kind === 'cmd') return ['cmd.exe', ['/d', '/s', '/c', spec.bin, ...args], opts];
  return [spec.bin, args, opts]; // native
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
    path.join(home, '.opencode', 'bin'),
    ...versionManagerBins(home),
  ];

  // Ask the user's login shell for its PATH — captures nvm / Homebrew / asdf, etc.
  let shellPath = '';
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const r = spawnSync(shell, ['-lc', 'command -p echo "$PATH"'], {
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
