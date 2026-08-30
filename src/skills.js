// skills.js — the skill package store.
//
// A ChatPanel skill has been a prompt in the extension's settings, which is fine until a
// skill wants to carry the things the agentskills.io format carries: reference documents
// loaded only when needed, templates, and scripts. None of those can live in a browser
// extension — it has no filesystem, and running someone else's script inside it is on the
// Never list. They live here.
//
// So the bridge becomes a skill HOST, not a skill consumer. It scans directories, parses
// each SKILL.md into the shared record, and serves three levels on demand — the
// progressive-disclosure ladder the format is built around:
//
//   list()               name + description + what files exist        (cheap, every turn)
//   read(name)           the full SKILL.md body                       (when it is chosen)
//   readFile(name, p)    one reference/asset                          (when it is needed)
//
// It also scans ~/.agents/skills — the cross-tool convention several agent CLIs already
// use — so a skill written in another tool appears here with no export step. That is the
// point of putting the store in the bridge rather than in one client.
//
// ── SECURITY ──────────────────────────────────────────────────────────────────────────
// This module turns HTTP request strings into filesystem reads, which makes it the most
// dangerous file in the repo. Three rules, none of them optional:
//
//   1. A REQUESTED NAME IS NEVER A PATH. `read('../../.ssh/id_rsa')` resolves the name
//      against the scanned INDEX; a name that is not in the index does not exist. There
//      is no code path from a URL segment to a path join.
//   2. A REQUESTED FILE PATH IS CHECKED TWICE — lexically (the shared `isSafeSkillPath`,
//      which refuses traversal, absolute paths, drive letters, backslashes and control
//      characters) and then again after resolution, because a SYMLINK inside a skill
//      directory passes every lexical check and still points at ~/.ssh.
//   3. EVERY READ IS CAPPED. A skill directory is not necessarily authored by the person
//      running it, and an unbounded read of a file someone else chose is a denial of
//      service against the process the browser depends on.

import { readFile as fsReadFile, readdir, stat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { join, resolve, sep } from 'node:path';
import { isSafeSkillPath, normalizeSkill, SKILL_FILE_KINDS } from './events/skill-manifest.js';

const MAX_SKILL_MD = 512 * 1024;   // a procedure document, not a corpus
const MAX_ASSET = 4 * 1024 * 1024; // a reference doc or a template; images live elsewhere
const MAX_SKILLS = 500;            // a scan is bounded work, not "whatever is on disk"
const MAX_DEPTH = 2;               // <root>/<name>/ and <root>/<category>/<name>/

/**
 * The agent CLIs that keep skills in a well-known directory, and what to call each one.
 *
 * Every one of these stores the SAME agentskills.io layout — `<name>/SKILL.md` plus
 * optional `references/`. In practice a machine ends up with the same skill copied into
 * several of them, which is the duplication the shared `~/.agents/skills` convention
 * exists to end and has not yet. Reading all of them is what lets ChatPanel show the
 * user's actual skills rather than the subset that happens to live in one folder.
 *
 * Ordered: ChatPanel's own directory, then the cross-tool convention, then each agent.
 * The order IS the precedence — see skillRoots.
 */
export const AGENT_SKILL_DIRS = Object.freeze([
  { source: 'local', label: 'ChatPanel', segments: ['.chatpanel', 'skills'], writable: true },
  { source: 'agents-dir', label: 'Shared (~/.agents)', segments: ['.agents', 'skills'] },
  { source: 'claude', label: 'Claude Code', segments: ['.claude', 'skills'] },
  { source: 'codex', label: 'Codex', segments: ['.codex', 'skills'] },
  { source: 'copilot', label: 'GitHub Copilot', segments: ['.copilot', 'skills'] },
  { source: 'gemini', label: 'Antigravity / Gemini', segments: ['.gemini', 'skills'] },
  { source: 'opencode', label: 'OpenCode', segments: ['.opencode', 'skills'] },
  { source: 'kiro', label: 'Kiro', segments: ['.kiro', 'skills'] },
  { source: 'pi', label: 'Pi', segments: ['.pi', 'skills'] },
  { source: 'hermes', label: 'Hermes', segments: ['.hermes', 'skills'] },
]);

/**
 * Where skills are scanned from, in precedence order — first hit wins on a name clash.
 *
 * ChatPanel's own directory is authoritative, then the shared cross-tool one, then each
 * agent's. That order matters because the same skill genuinely does exist in several of
 * these at once: whichever root answers first is the copy that gets shown, and a stable
 * order means the answer does not change between scans.
 *
 * Only the first is written. The rest belong to whatever else the user runs, and a tool
 * that edits another tool's configuration directory is a tool people uninstall.
 */
export function skillRoots(env = process.env, home = os.homedir()) {
  const extra = String(env.CHATPANEL_SKILL_DIRS || '')
    .split(/[:;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [
    ...AGENT_SKILL_DIRS.map((d) => ({
      dir: join(home, ...d.segments),
      source: d.source,
      label: d.label,
      writable: !!d.writable,
    })),
    ...extra.map((dir) => ({ dir: resolve(dir), source: 'external', label: 'Custom', writable: false })),
  ];
}

/**
 * The YAML subset a SKILL.md frontmatter block actually uses: scalars, inline `[a, b]`
 * lists, and one level of nesting. Deliberately NOT a YAML parser — a real one is a
 * dependency the bridge does not take, and a full parser is a larger attack surface than
 * the five fields we read. Anything it does not understand is ignored, never guessed at.
 */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text || ''));
  if (!m) return { meta: {}, body: String(text || '') };
  const out = {};
  const stack = [{ indent: -1, obj: out }];
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    const kv = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    const [, key, rest] = kv;
    if (rest === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
      continue;
    }
    parent[key] = scalar(rest);
  }
  return { meta: out, body: String(text).slice(m[0].length) };
}

function scalar(v) {
  const s = v.trim().replace(/\s+#.*$/, '').trim();
  if (/^\[.*\]$/.test(s)) {
    return s.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  return unquote(s);
}

const unquote = (s) => (/^(['"]).*\1$/.test(s) ? s.slice(1, -1) : s);

/** A directory name usable as a skill id when the frontmatter has no `name`. */
const ID = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Turn a parsed SKILL.md plus its directory listing into the shared record.
 *
 * Local skills carry an ORIGIN, and therefore read as `community` rather than `user`.
 * That is deliberate and it is the conservative answer: we cannot tell a skill the user
 * wrote from one that arrived in a synced or checked-out directory, and treating the
 * second as trusted is exactly the mistake. Only skills authored in ChatPanel itself are
 * the user's own.
 */
export function skillRecord({ meta, body, dirName, relPath, source, files, hash }) {
  const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : dirName;
  const id = ID.test(String(name)) ? String(name) : dirName;
  const grouped = {};
  for (const kind of SKILL_FILE_KINDS) {
    const list = files.filter((f) => f.startsWith(`${kind}/`)).map((f) => f.slice(kind.length + 1));
    if (list.length) grouped[kind] = list;
  }
  return normalizeSkill({
    id,
    name: String(name),
    command: ID.test(id) ? id : '',
    description: typeof meta.description === 'string' ? meta.description : '',
    prompt: body.trim(),
    ...(typeof meta.version === 'string' ? { version: meta.version } : {}),
    ...(Array.isArray(meta.platforms) ? { platforms: meta.platforms } : {}),
    ...(Object.keys(grouped).length ? { files: grouped } : {}),
    origin: { source, id: relPath, hash },
  });
}

/** Does this skill run on the machine we are on? */
export function platformOk(skill, platform = process.platform) {
  const want = skill?.platforms;
  if (!Array.isArray(want) || !want.length) return true;
  const here = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';
  return want.includes(here);
}

async function listDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // a root that does not exist is not an error — most machines have neither
  }
}

/** Files a package carries, relative to its directory, capped and traversal-checked. */
async function packageFiles(dir) {
  const out = [];
  for (const kind of SKILL_FILE_KINDS) {
    for (const entry of await listDir(join(dir, kind))) {
      if (!entry.isFile()) continue; // no recursion, and never a symlink or a device
      const rel = `${kind}/${entry.name}`;
      if (isSafeSkillPath(rel)) out.push(rel);
      if (out.length >= 200) return out;
    }
  }
  return out;
}

async function loadSkill(dir, relPath, source) {
  let text;
  try {
    const st = await stat(join(dir, 'SKILL.md'));
    if (!st.isFile() || st.size > MAX_SKILL_MD) return null;
    text = await fsReadFile(join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(text);
  const hash = `sha256-${createHash('sha256').update(text).digest('hex').slice(0, 32)}`;
  const dirName = relPath.split('/').pop();
  const files = await packageFiles(dir);
  const skill = skillRecord({ meta, body, dirName, relPath, source, files, hash });
  return { skill, dir };
}

/**
 * Scan every root. Returns an INDEX keyed by id — and that index is the only thing a
 * later read may resolve a requested name against.
 */
export async function scanSkills({ roots = skillRoots(), platform = process.platform } = {}) {
  const index = new Map();
  const problems = [];
  for (const { dir: root, source } of roots) {
    const walk = async (dir, rel, depth) => {
      if (index.size >= MAX_SKILLS || depth > MAX_DEPTH) return;
      for (const entry of await listDir(dir)) {
        if (index.size >= MAX_SKILLS) return;
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const child = join(dir, entry.name);
        const loaded = await loadSkill(child, childRel, source).catch((e) => {
          problems.push({ path: childRel, reason: String(e?.message || e) });
          return null;
        });
        if (loaded) {
          // First root wins: ChatPanel's own directory is authoritative over a shared one.
          if (!index.has(loaded.skill.id) && platformOk(loaded.skill, platform)) {
            index.set(loaded.skill.id, { ...loaded, root, source });
          }
        } else {
          await walk(child, childRel, depth + 1);
        }
      }
    };
    await walk(root, '', 1);
  }
  return { index, problems };
}

/** Level 0 — what exists, cheaply. No bodies. */
export function listRecords(index) {
  return [...index.values()].map(({ skill }) => {
    const { prompt, ...rest } = skill;
    return { ...rest, promptChars: (prompt || '').length };
  });
}

/** Level 1 — one skill, body included. `name` is resolved against the index, never joined. */
export function readRecord(index, name) {
  const hit = index.get(String(name || ''));
  return hit ? hit.skill : null;
}

/**
 * Level 2 — one file inside a package.
 *
 * The lexical check happens first and the resolved-path containment check happens after,
 * because they catch different things: the first stops `../`, the second stops a symlink
 * that points outside the package while looking perfectly ordinary.
 */
export async function readPackageFile(index, name, relPath) {
  const hit = index.get(String(name || ''));
  if (!hit) return { error: 'unknown skill' };
  if (!isSafeSkillPath(relPath)) return { error: 'unsafe path' };
  const kind = String(relPath).split('/')[0];
  if (!SKILL_FILE_KINDS.includes(kind)) return { error: 'unsafe path' };

  const target = resolve(hit.dir, relPath);
  let real;
  try {
    real = await realpath(target);
  } catch {
    return { error: 'not found' };
  }
  // A symlink passes every string check ever written. Compare what the filesystem
  // actually resolved to against the package root, with a separator so `/skills-evil`
  // cannot pass as a child of `/skills`.
  const rootReal = await realpath(hit.dir).catch(() => hit.dir);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) return { error: 'outside package' };

  const st = await stat(real).catch(() => null);
  if (!st?.isFile()) return { error: 'not found' };
  if (st.size > MAX_ASSET) return { error: 'file too large' };
  return { path: relPath, text: await fsReadFile(real, 'utf8') };
}

/**
 * A cached view, because /health and every turn ask "what skills exist" far more often
 * than the directories change. Short TTL rather than a watcher: a watcher on directories
 * that may not exist, across three roots, is more moving parts than a 5-second staleness
 * window is worth.
 */
const CACHE_MS = 5000;
let cached = null;

export async function skillIndex({ force = false, now = Date.now } = {}) {
  const t = now();
  if (!force && cached && t - cached.at < CACHE_MS) return cached.value;
  const value = await scanSkills();
  cached = { at: t, value };
  return value;
}

export function clearSkillCache() { cached = null; }

/** The `/health` summary — counts and roots, never contents. */
export async function skillsHealth() {
  const { index, problems } = await skillIndex();
  const used = new Set([...index.values()].map((v) => v.root));
  return {
    count: index.size,
    // Only roots that actually contributed. A list of every path we looked in would be
    // mostly absent directories, and would say nothing about what the user has.
    roots: skillRoots().filter((r) => used.has(r.dir)).map((r) => r.dir),
    sources: [...new Set([...index.values()].map((v) => v.source))].sort(),
    ...(problems.length ? { problems: problems.length } : {}),
  };
}
