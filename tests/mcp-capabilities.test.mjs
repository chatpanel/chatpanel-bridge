// ChatPanel's own capabilities, exposed as MCP tools any CLI can add.
//
// The point: a Codex or Claude Code that adds the ChatPanel MCP server once gets ChatPanel's
// bridge-native capabilities — starting with skill discovery — WITHOUT a browser chat open.
// The /mcp handler used to advertise zero tools with no active session; now it always offers
// these. A registry, so a new capability is a new tool without touching the handler.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capabilityToolSpecs, runCapabilityTool } from '../src/mcp-capabilities.js';
import { clearSkillCache } from '../src/skills.js';
import { readFileSync } from 'node:fs';

function withSkill(fn) {
  const root = mkdtempSync(join(tmpdir(), 'cp-mcp-'));
  mkdirSync(join(root, 'demo', 'references'), { recursive: true });
  writeFileSync(join(root, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: A demo skill\n---\n# Demo\nRead references/guide.md.');
  writeFileSync(join(root, 'demo', 'references', 'guide.md'), '# The guide\nStep one.');
  const prev = process.env.CHATPANEL_SKILL_DIRS;
  process.env.CHATPANEL_SKILL_DIRS = root;
  clearSkillCache();
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.CHATPANEL_SKILL_DIRS; else process.env.CHATPANEL_SKILL_DIRS = prev;
    clearSkillCache();
    rmSync(root, { recursive: true, force: true });
  });
}

test('the capability tools are namespaced and self-describing', () => {
  const specs = capabilityToolSpecs();
  const names = specs.map((s) => s.name);
  assert.deepEqual(names, ['chatpanel_skill_list', 'chatpanel_skill_open', 'chatpanel_skill_read', 'chatpanel_sanitize_text']);
  for (const s of specs) {
    assert.ok(s.name.startsWith('chatpanel_'), 'ours are namespaced so they never clash with a page tool');
    assert.ok(s.description.length > 20, 'a CLI shows this to its model — it has to say what the tool is for');
    assert.ok(s.inputSchema, 'and carry a schema');
  }
});

test('skill_list returns the installed skills, with provenance', async () => {
  await withSkill(async () => {
    const out = await runCapabilityTool('chatpanel_skill_list', {});
    const data = JSON.parse(out.content[0].text);
    const demo = data.skills.find((s) => s.name === 'demo');
    assert.ok(demo, 'the installed skill is listed');
    assert.equal(demo.description, 'A demo skill');
    assert.equal(demo.from, 'external');
  });
});

test('skill_open loads the body; skill_read loads a reference', async () => {
  await withSkill(async () => {
    const opened = await runCapabilityTool('chatpanel_skill_open', { name: 'demo' });
    assert.match(opened.content[0].text, /Read references\/guide\.md/);
    const ref = await runCapabilityTool('chatpanel_skill_read', { name: 'demo', path: 'references/guide.md' });
    assert.match(ref.content[0].text, /Step one/);
  });
});

test('a scripts path is refused as a text read even here', async () => {
  await withSkill(async () => {
    const out = await runCapabilityTool('chatpanel_skill_read', { name: 'demo', path: 'scripts/run.sh' });
    assert.ok(out.isError || /scripts|Could not/.test(out.content[0].text));
  });
});

test('sanitize strips hidden and look-alike characters', async () => {
  // Bridge-native security hygiene — a real capability, honestly scoped (not full PII).
  const out = await runCapabilityTool('chatpanel_sanitize_text', { text: 'hi\u200bthere\u202eevil' });
  const d = JSON.parse(out.content[0].text);
  assert.equal(d.hadHiddenCharacters, true);
  assert.ok(d.removed >= 2);
  assert.equal(d.clean, 'hithereevil', 'the invisible channels are gone');
  const clean = await runCapabilityTool('chatpanel_sanitize_text', { text: 'ordinary text' });
  assert.equal(JSON.parse(clean.content[0].text).hadHiddenCharacters, false);
});

test('an unknown skill and an unknown tool are handled, not thrown', async () => {
  await withSkill(async () => {
    const miss = await runCapabilityTool('chatpanel_skill_open', { name: 'nope' });
    assert.equal(miss.isError, true);
    assert.match(miss.content[0].text, /No such skill/);
  });
  assert.equal(await runCapabilityTool('not_a_tool', {}), null, 'a tool that is not ours returns null so the handler can fall through');
});

test('the /mcp handler advertises these with no active session', () => {
  const src = readFileSyncSafe('../src/server.js');
  assert.match(src, /const capTools = capabilityToolSpecs\(\)/, 'the handler enumerates the registry');
  assert.match(src, /tools: \[\.\.\.capTools, \.\.\.pageTools\]/, 'capability tools first, page tools on top');
  assert.match(src, /const cap = await runCapabilityTool/, 'a capability call runs in the bridge, no browser needed');
});

function readFileSyncSafe(rel) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}
