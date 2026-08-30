// mcp-capabilities.js — ChatPanel's own capabilities, exposed as MCP tools.
//
// The /mcp endpoint used to relay ONLY the page tools of an active browser chat: nothing
// to offer unless ChatPanel was open and driving. That makes ChatPanel a thing you drive,
// never a thing another agent can draw on. This is the other direction — a Codex or a
// Claude Code that adds the ChatPanel MCP server once gets ChatPanel's bridge-native
// capabilities as ordinary tools, whether or not a browser is open.
//
// A REGISTRY, so a new capability becomes an MCP tool by being registered — not by editing
// the MCP handler. That is the whole point of the ask "future capabilities should be
// available automatically": the handler enumerates this list, it does not hardcode a set.
//
// WHAT BELONGS HERE: capabilities the bridge can serve on its own — skills (on disk),
// redaction (the vendored pii engine), local MCP proxying. Notes, meetings and chat history
// live in the browser's encrypted on-device store; the bridge cannot read them, so they are
// NOT here — they stay behind the active-session relay (or a future shared store), and
// exposing on-device history to an external CLI is a privacy decision to make deliberately,
// not a tool to switch on by default.

import { skillIndex, listRecords, readRecord, readPackageFile } from './skills.js';

const MAX_REF = 24_000;

/**
 * The always-on capability tools. Each: { name, description, schema, run(args) -> content }.
 * `run` returns MCP content parts. Kept small and pure-ish; the store calls are the only IO.
 */
export function capabilityTools() {
  return [
    {
      name: 'chatpanel_skill_list',
      description:
        'List the skills installed on this machine that ChatPanel can see — across every '
        + 'agent harness (Claude Code, Codex, Copilot, Gemini, Hermes, ~/.agents) and any '
        + 'configured folder. Returns each skill\'s name and one-line description. Call this '
        + 'first, then chatpanel_skill_open to load the instructions of the one that fits.',
      schema: { type: 'object', properties: {} },
      async run() {
        const { index } = await skillIndex();
        const rows = listRecords(index).map((s) => ({
          name: s.command || s.id,
          title: s.name,
          description: s.description || '',
          from: s.origin?.source || 'local',
          references: (s.files?.references || []).length || undefined,
        }));
        return text(JSON.stringify({ skills: rows }, null, 2));
      },
    },
    {
      name: 'chatpanel_skill_open',
      description:
        'Load one skill\'s full instructions by name (from chatpanel_skill_list). Follow what '
        + 'it returns. If the instructions point at reference files, read one with '
        + 'chatpanel_skill_read.',
      schema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The skill name from chatpanel_skill_list.' } },
        required: ['name'],
      },
      async run(args) {
        const { index } = await skillIndex();
        const skill = readRecord(index, String(args?.name || '').trim());
        if (!skill) return text(`No such skill "${args?.name}". Use chatpanel_skill_list to see what is available.`, true);
        return text(skill.prompt || '(this skill has no extra instructions — just apply it.)');
      },
    },
    {
      name: 'chatpanel_skill_read',
      description:
        'Read one reference file a skill\'s instructions point at (any path inside the skill\'s '
        + 'own folder). Use only when the task needs it.',
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The skill name.' },
          path: { type: 'string', description: 'The reference path as written in the instructions, e.g. references/auth.md.' },
        },
        required: ['name', 'path'],
      },
      async run(args) {
        const { index } = await skillIndex();
        const out = await readPackageFile(index, String(args?.name || '').trim(), String(args?.path || '').trim());
        if (out.error) return text(`Could not read it: ${out.error}`, true);
        const body = out.text.length > MAX_REF ? `${out.text.slice(0, MAX_REF)}\n\n…[truncated]` : out.text;
        return text(body);
      },
    },
  ];
}

function text(s, isError = false) {
  return { content: [{ type: 'text', text: String(s) }], ...(isError ? { isError: true } : {}) };
}

/** MCP tools/list shape for the capability tools. */
export function capabilityToolSpecs() {
  return capabilityTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema }));
}

/** Run one capability tool by name, or null if it is not one of ours. */
export async function runCapabilityTool(name, args) {
  const tool = capabilityTools().find((t) => t.name === name);
  if (!tool) return null;
  try {
    return await tool.run(args || {});
  } catch (e) {
    return text(`error: ${e?.message || e}`, true);
  }
}
