// What an agent can already reach, read from its own configuration.
//
// A CLI agent brings connectors ChatPanel cannot see: a Slack MCP, a Jira MCP, a filesystem.
// ChatPanel relays its own tools to that agent and says a great deal about them — all of it
// restrictive, because each line was written to stop one substitution — so an agent asked
// about an internal thread read the page, saw the reference, and told the user to go and look
// it up, while holding a connector that reaches it.
//
// Knowing the names turns a guess into a fact. It lets the harness say "you have slack
// connected — use it" instead of listing connectors the agent may not have, and lets routing
// treat "can reach Slack" as a capability rather than a hope.
//
// NAMES ONLY, AND NEVER THE CREDENTIALS. A server's name is what the agent already knows and
// what a prompt needs; its URL, argv and env are what a leak would be made of. This reads
// config files that belong to the user's own agents and returns a list of strings.
//
// CONFIGURED, NOT PROVEN. A server listed here may still fail to start. That is honest and
// useful — it is exactly what the agent itself will try — and probing for real would cost a
// process spawn per agent on every health poll.

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Read a file and parse it as JSON, or null. Missing and malformed are the same answer. */
async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

/** Every key of a `{ mcpServers: { name: {...} } }` block, wherever it appears. */
function fromMcpServers(obj) {
  const m = obj && typeof obj === 'object' ? obj.mcpServers || obj.mcp_servers : null;
  return m && typeof m === 'object' ? Object.keys(m) : [];
}

/**
 * `[mcp_servers.NAME]` table headers out of a TOML file.
 *
 * Deliberately a regex rather than a TOML parser: the bridge is zero-runtime-dependency by
 * design, and the only thing wanted here is the set of table names. Anything this misses
 * simply is not reported, which is the safe direction — a missing name costs a sentence in a
 * prompt, an invented one sends an agent looking for a connector it does not have.
 */
function fromToml(text) {
  const out = [];
  const re = /^\s*\[\s*mcp_servers\s*\.\s*([A-Za-z0-9._-]+)\s*\]/gm;
  for (const m of String(text || '').matchAll(re)) out.push(m[1]);
  return out;
}

async function readToml(file) {
  try { return fromToml(await readFile(file, 'utf8')); } catch { return []; }
}

const home = () => os.homedir();
const configHome = () => process.env.XDG_CONFIG_HOME || path.join(home(), '.config');

// Where each agent keeps the list. One entry per agent id in the /health registry; an agent
// with no entry simply reports nothing, which is what an unknown agent should do.
const SOURCES = {
  claude: async () => {
    const [main, project] = await Promise.all([
      readJson(path.join(home(), '.claude.json')),
      readJson(path.join(process.cwd(), '.mcp.json')),
    ]);
    return [...fromMcpServers(main), ...fromMcpServers(project)];
  },
  codex: async () => readToml(path.join(process.env.CODEX_HOME || path.join(home(), '.codex'), 'config.toml')),
  opencode: async () => {
    for (const f of [
      path.join(configHome(), 'opencode', 'opencode.json'),
      path.join(home(), 'Library', 'Application Support', 'opencode', 'opencode.jsonc'),
    ]) {
      const j = await readJson(f);
      const names = [...fromMcpServers(j), ...(j && j.mcp && typeof j.mcp === 'object' ? Object.keys(j.mcp) : [])];
      if (names.length) return names;
    }
    return [];
  },
};

/**
 * The connector names an agent is configured with — deduped, sorted, and bounded.
 *
 * Bounded because this rides in a health response and then into a system prompt: a user with
 * forty servers should cost a line, not a paragraph. Sorted so the value is stable across
 * polls and a settings page does not reorder itself.
 */
export async function connectorsFor(agentId, { max = 24 } = {}) {
  const read = SOURCES[agentId];
  if (!read) return [];
  try {
    const names = await read();
    return [...new Set(names.filter((n) => typeof n === 'string' && n && n.length <= 64))].sort().slice(0, max);
  } catch {
    // A config we cannot read is a config we say nothing about. Never a reason to fail a
    // health check the extension needs in order to show the agent at all.
    return [];
  }
}
