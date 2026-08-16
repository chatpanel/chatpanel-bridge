// Built-in CLI agents — pi, opencode, kiro — that reuse the shared custom-engine
// runner (runSpec) with a fixed spec each. These are fixed built-in engines and are
// not entitlement-gated; custom BYO CLIs are handled by custom.js.
//
// Specs come from each CLI's actual flags:
//   pi       — pi -p "<prompt>"        · --model · @{path} images · --list-models
//   opencode — opencode run "<prompt>" · -m provider/model · -f {path} images · models
//   kiro     — kiro-cli chat --no-interactive "<prompt>" · --model · --list-models

import { runSpec, listSpecModels, runForStdout } from './custom.js';
import { findAgentBin } from '../env.js';

// `listModels` override hook: a CLI whose model listing isn't "one id per line"
// (Copilot prints a quoted list inside `help config`) passes its own parser here
// instead of forcing the generic one to grow special cases.
function makeCliAgent(command, spec, notFoundHint, overrides = {}) {
  let installed = false;
  let lastProbe = 0;
  const resolvedSpec = { ...spec, command };
  return {
    spec: resolvedSpec,
    async available() {
      // Cache a positive result; re-probe (throttled) while not found so it
      // self-heals once the CLI appears on PATH.
      if (!installed && Date.now() - lastProbe > 4000) {
        lastProbe = Date.now();
        try {
          installed = !!findAgentBin(command);
        } catch {
          installed = false;
        }
      }
      return installed ? { ok: true } : { ok: false, reason: notFoundHint };
    },
    listModels(options = {}) {
      if (overrides.listModels) return overrides.listModels(command, options);
      return listSpecModels(command, spec.listModelsArgs, options.workingDir);
    },
    chat(input, emit, opts) {
      return runSpec(resolvedSpec, input, emit, opts);
    },
  };
}

export const pi = makeCliAgent(
  'pi',
  {
    args: '-p',
    promptVia: 'arg',
    modelArg: '--model {model}',
    imageArg: '@{path}',
    toolAdapter: 'pi-extension',
    listModelsArgs: '--list-models',
    label: 'Pi',
  },
  'pi not found on PATH. Install Pi, then run `pi` once to sign in.',
);

export const opencode = makeCliAgent(
  'opencode',
  {
    // `--format json` → clean NDJSON events (the default emits a TUI that's
    // garbage when piped). --dangerously-skip-permissions so headless tool use
    // (incl. our relayed browser tools) doesn't block on an approval prompt.
    args: 'run --format json --dangerously-skip-permissions',
    promptVia: 'arg',
    modelArg: '-m {model}',
    imageArg: '-f {path}',
    format: 'opencode-json',
    // Browser tools come via the bridge's STABLE /mcp endpoint, registered once
    // with `opencode mcp add chatpanel --url http://127.0.0.1:4319/mcp` (opencode
    // only loads MCP from its global config, not a per-run file).
    requiresStableMcp: true,
    stableMcpConfigCheck: 'opencode',
    listModelsArgs: 'models',
    label: 'OpenCode',
  },
  'opencode not found on PATH. Install opencode, then sign in.',
);

export const kiro = makeCliAgent(
  'kiro-cli',
  {
    args: 'chat --no-interactive --require-mcp-startup',
    promptVia: 'arg',
    modelArg: '--model {model}',
    // Kiro can see MCP tools with --trust-tools, but in --no-interactive mode it
    // only executes MCP calls when this broader trust flag is present.
    trustAllToolsForMcp: true,
    trustAllToolsArg: '--trust-all-tools',
    requiresStableMcp: true,
    autoSetupStableMcp: true,
    stableMcpConfigCheck: 'kiro',
    stableMcpSetupArgs: ['mcp', 'add', '--scope', 'global', '--name', 'chatpanel_browser', '--url', 'http://127.0.0.1:4319/mcp', '--force'],
    stableMcpSetupCommand: 'kiro-cli mcp add --scope global --name chatpanel_browser --url http://127.0.0.1:4319/mcp --force',
    listModelsArgs: '--list-models',
    label: 'Kiro',
  },
  'kiro-cli not found on PATH. Install Kiro CLI, then sign in.',
);

// GitHub Copilot CLI. Verified against 1.0.80 (`copilot`, not the old
// `gh copilot` extension).
//
// The two things that make or break headless Copilot:
//   1. --allow-all-tools is REQUIRED in -p mode. Without it EVERY tool call dies
//      with "Permission denied and could not request permission from user" — the
//      CLI has no TTY to ask on — so the agent answers as if it had no tools.
//   2. --output-format json turns the TUI into clean NDJSON we can stream;
//      the default text output is not parseable as a live stream.
// Both live in the base spec because neither is optional for this integration.
//
// Permission mode maps onto Copilot's real permission surface (see
// permissionArgs): tools always run unattended, while filesystem reach beyond the
// working dir and arbitrary URL access are what the mode actually escalates.
const COPILOT_BASE_ARGS = [
  '-p', '{prompt}',
  '--output-format', 'json',
  '--no-color',
  '--log-level', 'none',
  // Headless hygiene: never block asking the user a question, never self-update
  // mid-turn, and don't ship the session to GitHub web/mobile from a ChatPanel
  // turn (Copilot exports by default; ChatPanel keeps chat local by policy).
  '--no-ask-user',
  '--no-auto-update',
  '--no-remote',
  '--no-remote-export',
];

export const copilot = makeCliAgent(
  'copilot',
  {
    args: COPILOT_BASE_ARGS,
    promptVia: 'arg',
    modelArg: '--model {model}',
    // Non-interactive-only flag; one per image.
    imageArg: '--attachment {path}',
    format: 'copilot-json',
    // Copilot takes per-run MCP servers, so browser tools work WITHOUT touching
    // the user's ~/.copilot/mcp-config.json (unlike opencode/kiro, which only
    // read global config). `@` prefix = "this is a file path, not inline JSON";
    // the shape runSpec writes ({mcpServers:{name:{command,args}}}) is the one
    // Copilot expects — verified.
    mcpArg: '--additional-mcp-config @{file}',
    permissionArgs: {
      // Tools yes (or nothing works); no path escape, no arbitrary URLs.
      default: ['--allow-all-tools'],
      // Edits anywhere on disk, still no arbitrary URL fetching.
      acceptEdits: ['--allow-all-tools', '--allow-all-paths'],
      // == --allow-all-tools --allow-all-paths --allow-all-urls
      bypassPermissions: ['--allow-all'],
    },
    forbidden: 'copilot',
    label: 'GitHub Copilot',
  },
  'copilot not found on PATH. Install GitHub Copilot CLI, then run `copilot login`.',
  { listModels: (command, options) => listCopilotModels(command, options.workingDir) },
);

// Copilot has no `--list-models`, and an invalid --model reports only that the
// model is unavailable without naming the valid ones. `copilot help config`
// documents the live list under its `model` key, so read it there — the ids stay
// in step with the installed CLI instead of being hardcoded here.
export async function listCopilotModels(command = 'copilot', workingDir) {
  const stdout = await runForStdout(command, ['help', 'config'], workingDir);
  const out = [];
  const seen = new Set();
  let inModelBlock = false;
  for (const raw of String(stdout || '').split('\n')) {
    // Section keys are printed as `  `key`: description`.
    const key = /^\s*`([A-Za-z][\w.]*)`\s*:/.exec(raw);
    if (key) {
      inModelBlock = key[1] === 'model';
      continue;
    }
    if (!inModelBlock) continue;
    const m = /^\s*-\s*"([^"]+)"\s*$/.exec(raw);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 200) break;
  }
  // `auto` is a real, documented value (Copilot routes the turn itself) but it is
  // not in the enumerated list — offer it first.
  return out.length ? ['auto', ...out] : [];
}

// DeepSeek Harness. The launcher is `dsh`; `--profile headless` is the shipped
// one-shot template ("answer one task, print the final assistant message, exit").
//
// Deliberately sparse compared to the others, because the CLI surface is sparse:
// the headless profile takes ONLY the task text. There is no --model, no JSON
// output and no resume flag — dsh is a Cordis plugin tree, so the model adapter,
// tools and MCP are chosen by the PROFILE, not by argv. Power users retarget it
// with `--patch <file>` through the agent's "Extra arguments" field.
//
// Two consequences worth knowing before wiring UI to this:
//   * `modelArg` is absent, so a model picked in Settings is ignored by design
//     (runSpec skips model injection without a template) — configure it in the
//     profile instead.
//   * Output arrives as ONE chunk at the end, not token-by-token, so the turn
//     shows progress but no live typing.
export const deepseek = makeCliAgent(
  'dsh',
  {
    args: ['--profile', 'headless', '{prompt}'],
    promptVia: 'arg',
    format: 'text',
    // No --model flag exists. dsh takes the model as a CONFIG OVERLAY: --patch
    // replaces one row of the composed plugin tree by id, and the model lives in
    // the `agent-default-model` row. runSpec writes this file per turn.
    modelPatch: {
      arg: '--patch {file}',
      // A patch replaces the row's WHOLE config, so provider must be restated.
      build: (model) => `- id: ${DSH_MODEL_ROW}\n  config:\n    provider: ${DSH_PROVIDER}\n    model: ${JSON.stringify(model)}\n`,
    },
    label: 'DeepSeek Harness',
  },
  'dsh not found on PATH. Install DeepSeek Harness, then run `dsh --profile headless "hi"` once to check the profile.',
  { listModels: (command, options) => listDshModels(command, options.workingDir) },
);

const DSH_MODEL_ROW = 'agent-default-model';
const DSH_PROVIDER = 'deepseek-official';
// dsh ships no model catalog command. The provider names its supported ids only
// when you send a bad one ("The supported API model names are ..."), so these are
// those ids, unioned with whatever the profile is actually set to. The field
// still accepts any id — this is a convenience menu, not a whitelist.
const DSH_KNOWN_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];

// dsh publishes no model catalog — there is no `--list-models`, and the composed
// config tree carries only the model the profile is CURRENTLY set to. So "Load
// models" reports that one truthfully rather than inventing a menu; the field
// still accepts any id the provider serves, applied via the patch above.
export async function listDshModels(command = 'dsh', workingDir) {
  const stdout = await runForStdout(command, ['--profile', 'headless', '--dump-config'], workingDir, 60000);
  const lines = String(stdout || '').split('\n');
  const rowStart = new RegExp(`^-\\s*id:\\s*${DSH_MODEL_ROW}\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (!rowStart.test(lines[i])) continue;
    // Scan this row's block for `model: <id>`, stopping at the next top-level row.
    for (let j = i + 1; j < lines.length && !/^-\s*id:/.test(lines[j]); j++) {
      const m = /^\s*model:\s*['"]?([\w.:-]+)['"]?\s*$/.exec(lines[j]);
      if (m) return [...new Set([m[1], ...DSH_KNOWN_MODELS])];
    }
  }
  return [...DSH_KNOWN_MODELS];
}
