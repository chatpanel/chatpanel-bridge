// Resolve a usable PATH for spawning the agent CLIs (codex, gemini).
//
// When the bridge runs as a login service (LaunchAgent / Scheduled Task) — or as
// a double-clicked app — it inherits a MINIMAL PATH, not your interactive shell's.
// So CLIs installed via Homebrew, npm-global, nvm, etc. aren't found. We fix that
// by (1) asking your login shell for its PATH and (2) adding common bin dirs.

import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

let enriched = false;

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
    ...versionManagerBins(home),
  ];

  // Ask the user's login shell for its PATH — captures nvm / Homebrew / asdf, etc.
  let shellPath = '';
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const r = spawnSync(shell, ['-ilc', 'command -p echo "$PATH"'], {
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
}
