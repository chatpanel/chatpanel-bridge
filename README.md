# ChatPanel Bridge

A tiny localhost server that lets the ChatPanel Chrome extension talk to the
coding agents on your machine. A browser extension can't spawn local processes,
so this bridges the gap.

- **Claude Code** — embedded via `@anthropic-ai/claude-agent-sdk`, using your
  existing Claude Code login (or `ANTHROPIC_API_KEY`).
- **Codex** — driven via the `codex exec` CLI, using your `codex login`.
- **Antigravity CLI** — driven via the `agy -p` CLI, using your Antigravity login.
  This is Google's successor to Gemini CLI; **Gemini CLI** itself remains available
  for business/enterprise (paid API keys) and can be added as a custom agent.

Bring whichever agent you already have installed — the extension auto-detects
the ones the bridge reports as available.

## Run it

### macOS / Linux — one line, no Node.js needed

```bash
curl -fsSL https://dl.chatpanel.net/bridge/install.sh | bash
```

Downloads the standalone binary, installs it, and sets it to start at login
(installing via curl avoids the macOS "damaged" prompt). Re-running is a clean
in-place upgrade.

### Windows — via Node (recommended)

Windows SmartScreen flags unsigned downloads, so on Windows run the bridge through
Node — you already have it if you use Claude Code / Codex (both npm CLIs),
and there's no security prompt:

```powershell
npm i -g @chatpanel/bridge
chatpanel-bridge --install      # starts hidden at login
```

Just trying it? `npx @chatpanel/bridge` runs it once in the foreground.

Manage it anywhere: `chatpanel-bridge --status` · `--uninstall`.

### Manual download

Grab the binary from the
[latest release](https://github.com/chatpanel/chatpanel-bridge/releases/latest) and:

```bash
# macOS (clear the download quarantine first, then install)
xattr -cr chatpanel-bridge-macos-arm64
chmod +x chatpanel-bridge-macos-arm64
./chatpanel-bridge-macos-arm64 --install

# Windows (PowerShell) — click "More info → Run anyway" if SmartScreen warns
.\chatpanel-bridge-windows-x64.exe --install
```

> These binaries aren't code-signed yet, so macOS/Windows may warn on first run
> (the curl/npm routes above sidestep that). **Intel Mac?** No x64 binary yet —
> use npm (`npx @chatpanel/bridge`). Apple Silicon uses `chatpanel-bridge-macos-arm64`.

### Prerequisites

The agents you want to use must already be set up:

- **Claude Code**: installed and signed in (`claude`), or set `ANTHROPIC_API_KEY`.
- **Codex**: `codex` on your `PATH` and `codex login` done.
- **Antigravity CLI**: `agy` on your `PATH` and signed in (install the Antigravity app, then run `agy` once to sign in). Replaces Gemini CLI; business/enterprise users can still run `gemini` as a custom agent.

The extension polls `/health` and shows each agent as available/unavailable.

## Develop (from source)

Only if you're hacking on the bridge itself:

```bash
git clone https://github.com/chatpanel/chatpanel-bridge
cd chatpanel-bridge
npm install
npm start                    # → http://127.0.0.1:4319
```

## API

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/health` | `{ ok, version, agents:[{id,label,available,reason}] }` |
| `POST` | `/chat`   | SSE stream — body `{ agent, system, options, messages }` |
| `GET`  | `/v1/models` | OpenAI-compatible list of available local agents |
| `POST` | `/v1/chat/completions` | OpenAI-compatible Chat Completions (streaming and non-streaming) |
| `POST` | `/v1/completions` | OpenAI-compatible legacy text Completions (streaming and non-streaming) |
| `POST` | `/v1/responses` | OpenAI-compatible Responses API (streaming and non-streaming) |
| `POST` | `/v1/messages` | Anthropic-compatible Messages API (streaming and non-streaming) |
| `GET`  | `/skills` | skills installed on this machine, across every agent harness + configured folders |
| `GET`  | `/skills/<name>` · `/skills/<name>/file/<path>` | one skill's instructions · one reference file |
| `POST` | `/mcp` | MCP endpoint — `chatpanel_skill_*` tools any CLI can call (plus browser tools while a ChatPanel chat is driving) |

`/chat` streams Server-Sent Events: `{type:'delta',text}` as the answer is
generated, `{type:'tool',name,summary}` / `{type:'status'}` for activity, and a
final `{type:'done'}` (or `{type:'error',error}`).

### Use your skills from any CLI

The bridge discovers the skills installed on your machine — Claude Code, Codex, Copilot,
Gemini, Hermes, `~/.agents/skills`, and any folder you configure — and exposes them as MCP
tools (`chatpanel_skill_list` / `_open` / `_read`). Point any MCP client at
`http://127.0.0.1:4319/mcp` and it can list and load them with no browser open.

For **one** server that adds your local **history** (chats, meetings, notes — redacted)
*alongside* your skills, add the
[Privacy Gateway](https://github.com/chatpanel/chatpanel-gateway) instead and point your CLI
at `chatpanel-gateway mcp`. The gateway proxies these skill tools and puts redaction in front.

`options` per agent (set in ChatPanel Settings):

```jsonc
{
  "workingDir": "/path/to/project",   // where the agent reads/works
  "permissionMode": "default",         // default | acceptEdits | bypassPermissions
  "model": ""                          // optional model override
}
```

### OpenAI and Anthropic SDK compatibility

The compatibility routes run a local coding agent; they do not call a provider
API. Use the per-install token from `~/.chatpanel/bridge-token` as the SDK API
key. The token protects endpoints that can start local processes, so do not put
it in browser-delivered code or share it.

For OpenAI clients, set the base URL to `http://127.0.0.1:4319/v1` and use an
installed agent id such as `codex` as the model:

```js
import OpenAI from 'openai';
import { readFileSync } from 'node:fs';

const client = new OpenAI({
  apiKey: readFileSync(`${process.env.HOME}/.chatpanel/bridge-token`, 'utf8').trim(),
  baseURL: 'http://127.0.0.1:4319/v1',
});

const result = await client.responses.create({
  model: 'codex',
  input: 'Explain this project in three bullets.',
});
console.log(result.output_text);
```

`client.chat.completions.create(...)` and legacy `client.completions.create(...)`
work through the same base URL. For the Anthropic SDK, use
`http://127.0.0.1:4319` as its base URL and the same token as its API key;
requests to `/v1/messages` can also use `model: "codex"`.

The model field selects the local agent. `codex/gpt-5.5`, for example, selects
the Codex agent and passes `gpt-5.5` as its CLI model override. Advanced bridge
settings can be supplied through an extra `chatpanel` request object:

```jsonc
{
  "model": "codex",
  "messages": [{ "role": "user", "content": "Fix the failing tests." }],
  "chatpanel": {
    "working_dir": "/absolute/path/to/project",
    "permission_mode": "acceptEdits",
    "use_local_config": true
  }
}
```

The adapter currently covers text conversations. Provider-hosted function tools,
stored responses, log probabilities, and exact token accounting are not
available; unsupported tool requests return HTTP 400, and usage counts are zero.

## Safety

- Binds to `127.0.0.1` only; CORS accepts the extension origin and localhost.
- Claude tools are **read-only by default** (Read/Grep/Glob/WebFetch). Writes and
  shell only run when an agent's permission mode is `acceptEdits` or
  `bypassPermissions`.
- Point each agent at a working directory you trust.

## Run as a background service (optional)

macOS (launchd) example — save to `~/Library/LaunchAgents/app.chatpanel.bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>app.chatpanel.bridge</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/node</string><string>/ABSOLUTE/PATH/chatpanel/bridge/src/server.js</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

Then `launchctl load ~/Library/LaunchAgents/app.chatpanel.bridge.plist`.

## License

**Source-available**, under the [**PolyForm Shield License 1.0.0**](LICENSE).
Read, audit, run, and modify it for your own use — you just may not use it to
provide a product or service that **competes** with ChatPanel. The
[extension](https://github.com/chatpanel/chatpanel-extension) is under the same
license. This is *not* an OSI "open source" license; the source is published for
transparency and trust (this bridge runs on your machine with file access, so it
should be auditable), not for re-packaging or resale.

## Trademarks & brand

The name **“ChatPanel”**, the logo, and brand assets are **trademarks of ChatPanel,
not licensed** under the terms above — the Shield license covers the code only.
Don't redistribute a fork (e.g. to npm) under the ChatPanel name or marks.
