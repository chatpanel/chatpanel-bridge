// The skill store turns HTTP request strings into filesystem reads, so most of what is
// asserted here is what it REFUSES. A skill directory is not necessarily authored by the
// person running it — a shared ~/.agents/skills or a checked-out repo is the normal case
// — so "the package said so" is never a reason to read a file.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  listRecords, parseFrontmatter, platformOk, readPackageFile, readRecord,
  scanSkills, skillRecord, skillRoots, AGENT_SKILL_DIRS,
} from '../src/skills.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cp-skills-'));
  const write = (rel, text) => {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  };
  return { root, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const SKILL = (name, extra = '') => `---
name: ${name}
description: Does ${name} things
version: 1.2.0
${extra}---

# ${name}

## When to Use
When you need ${name}.
`;

test('frontmatter parsing covers the subset a SKILL.md actually uses', () => {
  const { meta, body } = parseFrontmatter(`---
name: my-skill
description: "Quoted, with: a colon"
version: 1.0.0
platforms: [macos, linux]
enabled: true
metadata:
  category: devops
  tags: [python, automation]
---
# Title
Body text.
`);
  assert.equal(meta.name, 'my-skill');
  assert.equal(meta.description, 'Quoted, with: a colon');
  assert.deepEqual(meta.platforms, ['macos', 'linux']);
  assert.equal(meta.enabled, true);
  assert.deepEqual(meta.metadata, { category: 'devops', tags: ['python', 'automation'] });
  assert.match(body, /^# Title/);
});

test('a file with no frontmatter is all body, not an error', () => {
  const { meta, body } = parseFrontmatter('# Just markdown\n');
  assert.deepEqual(meta, {});
  assert.equal(body, '# Just markdown\n');
});

test('the parser ignores what it does not understand rather than guessing', () => {
  // It is a five-field reader, not a YAML implementation. A block list or an anchor must
  // produce nothing, never a half-parsed value that reads as meaningful.
  const { meta } = parseFrontmatter('---\nname: x\nlist:\n  - a\n  - b\n---\nbody\n');
  assert.equal(meta.name, 'x');
  assert.deepEqual(meta.list, {}, 'an unsupported block is empty, not invented');
});

test('a skill on disk is community, not user', () => {
  // We cannot tell a skill the user wrote from one that arrived in a synced directory or
  // a git pull. Treating the second as trusted is the whole mistake.
  const rec = skillRecord({
    meta: { name: 'deploy', description: 'd' }, body: '# Deploy',
    dirName: 'deploy', relPath: 'devops/deploy', source: 'agents-dir', files: [], hash: 'sha256-a',
  });
  assert.equal(rec.origin.source, 'agents-dir');
  assert.equal(rec.origin.id, 'devops/deploy');
  assert.equal(rec.builtin, false);
  assert.equal(rec.trust, undefined, 'trust is derived, never stored');
});

test('platform restrictions are honoured', () => {
  assert.equal(platformOk({ platforms: ['macos'] }, 'darwin'), true);
  assert.equal(platformOk({ platforms: ['macos'] }, 'linux'), false);
  assert.equal(platformOk({ platforms: ['macos', 'linux'] }, 'win32'), false);
  assert.equal(platformOk({}, 'win32'), true, 'no restriction means everywhere');
});

test('roots cover every agent CLI, ChatPanel first', () => {
  // The same skill really is copied into several of these at once, so the ORDER is the
  // answer to "which copy gets shown" — and it has to be stable between scans.
  const roots = skillRoots({}, '/home/u');
  assert.deepEqual(roots.slice(0, 4).map((r) => r.dir), [
    '/home/u/.chatpanel/skills',
    '/home/u/.agents/skills',
    '/home/u/.claude/skills',
    '/home/u/.codex/skills',
  ]);
  for (const agent of ['claude', 'codex', 'copilot', 'gemini', 'opencode', 'kiro', 'pi', 'hermes']) {
    assert.ok(roots.some((r) => r.source === agent), `${agent} should be scanned`);
  }
  assert.ok(roots.every((r) => r.label), 'every root needs a name — it is shown as provenance');
});

test('only ChatPanel’s own directory is writable', () => {
  // A tool that edits another tool's configuration directory is a tool people uninstall.
  const roots = skillRoots({}, '/home/u');
  assert.deepEqual(roots.filter((r) => r.writable).map((r) => r.source), ['local']);
});

test('extra directories are appended, never inserted ahead of the known ones', () => {
  const base = skillRoots({}, '/home/u').length;
  const sep = process.platform === 'win32' ? ';' : ':';
  const withExtra = skillRoots({ CHATPANEL_SKILL_DIRS: `/team/skills${sep}/other` }, '/home/u');
  assert.equal(withExtra.length, base + 2);
  assert.deepEqual(withExtra.slice(-2).map((r) => r.source), ['external', 'external']);
});

test('the list separator is the platform’s, so a drive letter is not a separator', () => {
  // ':' is the POSIX list separator AND part of every absolute Windows path. Splitting on
  // a fixed set turned "C:\\Users\\me\\skills" into "C" and "\\Users\\me\\skills" on
  // Windows — two directories, neither of which exists. Using path.delimiter means each
  // platform splits on its own character and treats the other one as ordinary text, which
  // is the property asserted here rather than one platform's spelling of it.
  const extras = (v) => skillRoots({ CHATPANEL_SKILL_DIRS: v }, '/home/u').filter((r) => r.source === 'external');
  const other = delimiter === ';' ? ':' : ';';
  assert.equal(extras(`/a${delimiter}/b`).length, 2, 'the platform separator splits');
  assert.equal(extras(`/a${other}b`).length, 1, 'the other platform’s separator is just a character');
  if (delimiter === ';') {
    assert.equal(extras('C:\\Users\\me\\skills').length, 1, 'a drive letter survives on Windows');
  }
});

test('newlines separate directories on every platform', () => {
  const roots = skillRoots({ CHATPANEL_SKILL_DIRS: '/a\n/b\n\n  /c  ' }, '/home/u');
  assert.equal(roots.filter((r) => r.source === 'external').length, 3, 'blank lines are skipped');
});

test('a scan finds flat and one-level-nested skills, and their files', async () => {
  const fx = fixture();
  try {
    fx.write('summarize/SKILL.md', SKILL('summarize'));
    fx.write('devops/deploy/SKILL.md', SKILL('deploy'));
    fx.write('devops/deploy/references/runbook.md', '# Runbook');
    fx.write('devops/deploy/scripts/go.sh', 'echo hi');
    const { index } = await scanSkills({ roots: [{ dir: fx.root, source: 'local' }] });
    assert.deepEqual([...index.keys()].sort(), ['deploy', 'summarize']);
    const deploy = readRecord(index, 'deploy');
    assert.deepEqual(deploy.files, { references: ['runbook.md'], scripts: ['go.sh'] });
    assert.equal(deploy.origin.id, 'devops/deploy');
    assert.match(deploy.prompt, /When you need deploy/);
  } finally { fx.cleanup(); }
});

test('the first root wins a name clash', async () => {
  // ChatPanel's own directory is authoritative over a shared one, or another tool could
  // silently redefine a skill the user configured here.
  const a = fixture();
  const b = fixture();
  try {
    a.write('shared/SKILL.md', SKILL('shared').replace('Does shared things', 'from A'));
    b.write('shared/SKILL.md', SKILL('shared').replace('Does shared things', 'from B'));
    const { index } = await scanSkills({
      roots: [{ dir: a.root, source: 'local' }, { dir: b.root, source: 'agents-dir' }],
    });
    assert.equal(readRecord(index, 'shared').origin.source, 'local');
  } finally { a.cleanup(); b.cleanup(); }
});

test('the same skill in several agent folders resolves to one, deterministically', () => {
  // The real machine case: ~/.claude/skills, ~/.copilot/skills and ~/.gemini/skills each
  // hold their own COPY of the same skill. Whichever root comes first wins, every scan.
  const seen = new Set();
  for (const d of AGENT_SKILL_DIRS) {
    assert.equal(seen.has(d.source), false, `duplicate source id '${d.source}'`);
    seen.add(d.source);
  }
  assert.equal(AGENT_SKILL_DIRS[0].source, 'local', 'ChatPanel’s own copy always wins');
});

test('a skill for another platform is not indexed', async () => {
  const fx = fixture();
  try {
    fx.write('mac-only/SKILL.md', SKILL('mac-only', 'platforms: [macos]\n'));
    const { index } = await scanSkills({ roots: [{ dir: fx.root, source: 'local' }], platform: 'linux' });
    assert.equal(index.size, 0);
  } finally { fx.cleanup(); }
});

test('a missing root is not an error — most machines have neither', async () => {
  const { index, problems } = await scanSkills({ roots: [{ dir: '/nope/not/here', source: 'local' }] });
  assert.equal(index.size, 0);
  assert.deepEqual(problems, []);
});

test('the list level carries no bodies', async () => {
  const fx = fixture();
  try {
    fx.write('a/SKILL.md', SKILL('a'));
    const { index } = await scanSkills({ roots: [{ dir: fx.root, source: 'local' }] });
    const [row] = listRecords(index);
    assert.equal(row.prompt, undefined, 'level 0 is name + description, not the document');
    assert.ok(row.promptChars > 0, 'but it says how much there is');
    assert.equal(row.description, 'Does a things');
  } finally { fx.cleanup(); }
});

// --- what it refuses --------------------------------------------------------------

test('a requested name is resolved against the index, never joined onto a path', async () => {
  const fx = fixture();
  try {
    fx.write('a/SKILL.md', SKILL('a'));
    const { index } = await scanSkills({ roots: [{ dir: fx.root, source: 'local' }] });
    for (const evil of ['../../../etc/passwd', '..', '/etc/passwd', 'a/../../b']) {
      assert.equal(readRecord(index, evil), null, `should not resolve ${evil}`);
      const out = await readPackageFile(index, evil, 'references/x.md');
      assert.equal(out.error, 'unknown skill');
    }
  } finally { fx.cleanup(); }
});

test('traversal in a file path is refused', async () => {
  const fx = fixture();
  try {
    fx.write('a/SKILL.md', SKILL('a'));
    fx.write('a/references/ok.md', 'fine');
    writeFileSync(join(fx.root, 'secret.txt'), 'top secret');
    const { index } = await scanSkills({ roots: [{ dir: fx.root, source: 'local' }] });
    assert.equal((await readPackageFile(index, 'a', 'references/ok.md')).text, 'fine');
    for (const evil of ['../secret.txt', 'references/../../secret.txt', '/etc/passwd', 'references\\..\\x']) {
      const out = await readPackageFile(index, 'a', evil);
      assert.ok(out.error, `should refuse ${evil}`);
      assert.equal(out.text, undefined);
    }
  } finally { fx.cleanup(); }
});

test('a file outside the package directories is refused even when the path is clean', async () => {
  // SKILL.md itself is served by the read level; the file level is for the declared
  // package directories only, so an arbitrary sibling is not fetchable through it.
  const fx = fixture();
  try {
    fx.write('a/SKILL.md', SKILL('a'));
    fx.write('a/notes.txt', 'private');
    const { index } = await scanSkills({ roots: [{ dir: fx.root, source: 'local' }] });
    assert.equal((await readPackageFile(index, 'a', 'notes.txt')).error, 'unsafe path');
  } finally { fx.cleanup(); }
});

test('a symlink out of the package is refused — the lexical check cannot see it', async () => {
  // This is the case a string check can never catch: `references/keys` contains no `..`,
  // no absolute path and no backslash, and still resolves to a file outside the package.
  const fx = fixture();
  try {
    fx.write('a/SKILL.md', SKILL('a'));
    mkdirSync(join(fx.root, 'a', 'references'), { recursive: true });
    writeFileSync(join(fx.root, 'outside.txt'), 'private key material');
    symlinkSync(join(fx.root, 'outside.txt'), join(fx.root, 'a', 'references', 'keys'));
    const { index } = await scanSkills({ roots: [{ dir: fx.root, source: 'local' }] });
    const out = await readPackageFile(index, 'a', 'references/keys');
    assert.equal(out.error, 'outside package');
    assert.equal(out.text, undefined);
  } finally { fx.cleanup(); }
});

test('a symlinked file is not listed as part of the package either', async () => {
  const fx = fixture();
  try {
    fx.write('a/SKILL.md', SKILL('a'));
    mkdirSync(join(fx.root, 'a', 'references'), { recursive: true });
    writeFileSync(join(fx.root, 'outside.txt'), 'x');
    symlinkSync(join(fx.root, 'outside.txt'), join(fx.root, 'a', 'references', 'link.md'));
    const { index } = await scanSkills({ roots: [{ dir: fx.root, source: 'local' }] });
    assert.equal(readRecord(index, 'a').files, undefined, 'a symlink is not a package file');
  } finally { fx.cleanup(); }
});

test('an oversized SKILL.md is skipped rather than read into memory', async () => {
  const fx = fixture();
  try {
    fx.write('big/SKILL.md', 'x'.repeat(600 * 1024));
    fx.write('small/SKILL.md', SKILL('small'));
    const { index } = await scanSkills({ roots: [{ dir: fx.root, source: 'local' }] });
    assert.deepEqual([...index.keys()], ['small']);
  } finally { fx.cleanup(); }
});

test('nesting is bounded — a namespace above a category, and no further', async () => {
  // Three levels covers every layout seen in the wild: <name>/, <category>/<name>/, and
  // Codex's .system/<name>/. A fourth would be an unbounded walk of a user's home.
  const fx = fixture();
  try {
    fx.write('a/b/c/SKILL.md', SKILL('three-deep'));
    fx.write('w/x/y/z/SKILL.md', SKILL('four-deep'));
    const { index } = await scanSkills({ roots: [{ dir: fx.root, source: 'local' }] });
    assert.deepEqual([...index.keys()], ['three-deep'], 'four levels is not a scan, it is a crawl');
  } finally { fx.cleanup(); }
});

test('version control and package metadata are never scanned', async () => {
  const fx = fixture();
  try {
    fx.write('.git/SKILL.md', SKILL('git'));
    fx.write('node_modules/pkg/SKILL.md', SKILL('pkg'));
    const { index } = await scanSkills({ roots: [{ dir: fx.root, source: 'local' }] });
    assert.equal(index.size, 0);
  } finally { fx.cleanup(); }
});

test('a hidden directory is a namespace to walk through, not a skill to skip', async () => {
  // Codex ships its built-ins under ~/.codex/skills/.system/<name>/SKILL.md. Skipping
  // every dot-directory — a rule aimed at .git — hid six real skills.
  const fx = fixture();
  try {
    fx.write('.system/imagegen/SKILL.md', SKILL('imagegen'));
    fx.write('.system/skill-creator/SKILL.md', SKILL('skill-creator'));
    const { index } = await scanSkills({ roots: [{ dir: fx.root, source: 'codex' }] });
    assert.deepEqual([...index.keys()].sort(), ['imagegen', 'skill-creator']);
    assert.equal(readRecord(index, 'imagegen').origin.id, '.system/imagegen', 'the namespace stays in the id');
  } finally { fx.cleanup(); }
});

test('the namespace itself never becomes a skill', async () => {
  const fx = fixture();
  try {
    fx.write('.system/SKILL.md', SKILL('system'));
    const { index } = await scanSkills({ roots: [{ dir: fx.root, source: 'codex' }] });
    assert.equal(index.size, 0, 'a hidden directory is walked, never indexed');
  } finally { fx.cleanup(); }
});
