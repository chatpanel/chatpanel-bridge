// Built-in CLI agents — pi, opencode, kiro — that reuse the shared custom-engine
// runner (runSpec) with a FIXED spec each. Unlike the Pro "custom" engine, these
// are NOT entitlement-gated: they ship as built-ins, and the extension bounds
// free users to a single usable agent (FREE_LIMITS.bridgeAgents). Bring-your-own
// arbitrary CLIs stay Pro via custom.js.
//
// Specs come from each CLI's actual flags:
//   pi       — pi -p "<prompt>"        · --model · @{path} images · --list-models
//   opencode — opencode run "<prompt>" · -m provider/model · -f {path} images · models
//   kiro     — kiro-cli chat --no-interactive "<prompt>" · --model · --list-models

import { runSpec, listSpecModels } from './custom.js';
import { findAgentBin } from '../env.js';

function makeCliAgent(command, spec, notFoundHint) {
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
      return listSpecModels(command, spec.listModelsArgs, options.workingDir);
    },
    chat(input, emit) {
      return runSpec(resolvedSpec, input, emit);
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
    trustToolsArg: '--trust-tools={tools}',
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
