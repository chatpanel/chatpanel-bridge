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
  return {
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
      return runSpec({ ...spec, command }, input, emit);
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
    listModelsArgs: '--list-models',
    label: 'Pi',
  },
  'pi not found on PATH. Install Pi, then run `pi` once to sign in.',
);

export const opencode = makeCliAgent(
  'opencode',
  {
    args: 'run',
    promptVia: 'arg',
    modelArg: '-m {model}',
    imageArg: '-f {path}',
    listModelsArgs: 'models',
    label: 'OpenCode',
  },
  'opencode not found on PATH. Install opencode, then sign in.',
);

export const kiro = makeCliAgent(
  'kiro-cli',
  {
    args: 'chat --no-interactive',
    promptVia: 'arg',
    modelArg: '--model {model}',
    listModelsArgs: '--list-models',
    label: 'Kiro',
  },
  'kiro-cli not found on PATH. Install Kiro CLI, then sign in.',
);
