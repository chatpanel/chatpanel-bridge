// GENERATED — do not edit.
// Source of truth: chatpanel-channels/src/eventlog.js (npm @chatpanel/channels).
// Edit there, then run: npm run sync:channels
//
// Vendored rather than depended on: the bridge ships zero runtime dependencies so a
// curl one-liner install cannot fail on someone's registry, and so the compiled
// single-file binary has nothing to resolve. Package imports are rewritten to the
// vendored engines (src/pii, src/events) by the sync script.

// A file-backed sink for the capability/privacy events a channel run produces — the audit
// trail neither Claude Code Remote nor Hermes has. Events are metadata only (counts, ids;
// never message content — see chatpanel-events/event.js), so this JSONL is safe to keep and
// replicate. One line per event, append-only. seq is owned by the appender and recovered from
// the file on restart so ordering survives a bounce.

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createAppender } from '../events/event.js';

async function nextSeq(file) {
  try {
    const txt = await readFile(file, 'utf8');
    let max = -1;
    for (const l of txt.split('\n')) {
      if (!l) continue;
      try { const e = JSON.parse(l); if (Number.isInteger(e.seq)) max = Math.max(max, e.seq); } catch { /* skip */ }
    }
    return max + 1;
  } catch { return 0; }
}

export async function createEventLog({ file, host = 'channel' }) {
  await mkdir(path.dirname(file), { recursive: true });
  const seq = await nextSeq(file);
  const appender = createAppender({ host, seq, newId: () => globalThis.crypto.randomUUID() });
  return {
    host,
    get seq() { return appender.seq; },
    // Same signature as the raw appender, but persists. Returns the validated event.
    async append(type, payload, causes = []) {
      const e = appender.append(type, payload, causes);
      await appendFile(file, JSON.stringify(e) + '\n');
      return e;
    },
  };
}

// A no-op sink for the allow-list prototype or tests — same interface, writes nothing but
// still builds + validates each event, so a bad payload fails loudly here too.
export function nullEventLog({ host = 'channel' } = {}) {
  const appender = createAppender({ host, seq: 0, newId: () => globalThis.crypto.randomUUID() });
  return {
    host,
    get seq() { return appender.seq; },
    async append(type, payload, causes = []) { return appender.append(type, payload, causes); },
  };
}
