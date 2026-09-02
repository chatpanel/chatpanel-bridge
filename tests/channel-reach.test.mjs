// feature-f7 §7 (tool authorization): a channel/remote caller's reach tier is a CEILING on the
// toolset, enforced in the claude engine regardless of permissionMode. These lock the policy so a
// future edit can't silently widen what a paired phone may do.
import assert from 'node:assert/strict';
import test from 'node:test';
import { channelToolPolicy } from '../src/engines/claude.js';

test('absent reach → no cap (local callers keep permissionMode behavior)', () => {
  assert.equal(channelToolPolicy(undefined), null);
  assert.equal(channelToolPolicy(null), null);
  assert.equal(channelToolPolicy(''), null);
});

test("'any' → no cap (operator/local console)", () => {
  assert.equal(channelToolPolicy('any'), null);
});

test("'trusted' → machine-wide read, but NO web and NO writes/shell", () => {
  const { allow, deny } = channelToolPolicy('trusted');
  for (const t of ['Read', 'Grep', 'Glob']) assert.ok(allow.includes(t), `trusted should allow ${t}`);
  // The egress link is cut: no web tool is reachable, so reads can't be exfiltrated.
  for (const t of ['WebFetch', 'WebSearch']) {
    assert.ok(!allow.includes(t), `trusted must not allow ${t}`);
    assert.ok(deny.includes(t), `trusted must explicitly deny ${t}`);
  }
  // No writes/shell — a capped tier is read-only by construction.
  for (const t of ['Bash', 'Edit', 'Write']) {
    assert.ok(!allow.includes(t), `trusted must not allow ${t}`);
    assert.ok(deny.includes(t), `trusted must explicitly deny ${t}`);
  }
});

test("'device' → conversational only: no filesystem, no web, no writes/shell", () => {
  const { allow, deny } = channelToolPolicy('device');
  for (const t of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Bash', 'Edit', 'Write']) {
    assert.ok(!allow.includes(t), `device must not allow ${t}`);
  }
  for (const t of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch']) {
    assert.ok(deny.includes(t), `device must explicitly deny ${t}`);
  }
});

test('unknown reach → fail closed (treated as most restrictive, never "no cap")', () => {
  const policy = channelToolPolicy('superuser');
  assert.notEqual(policy, null, 'unknown tier must still be capped, not uncapped');
  assert.deepEqual(policy, channelToolPolicy('device'), 'unknown tier collapses to device');
});

test('policy arrays are copies — callers cannot mutate the shared policy', () => {
  const a = channelToolPolicy('trusted');
  a.allow.push('Bash');
  const b = channelToolPolicy('trusted');
  assert.ok(!b.allow.includes('Bash'), 'mutating one result must not leak into the next');
});
