# ChatPanel Bridge

A tiny localhost server that lets the ChatPanel Chrome extension talk to the
coding agents on your machine. A browser extension can't spawn local processes,
so this bridges the gap.

- **Claude Code** — embedded via `@anthropic-ai/claude-agent-sdk`, using your
  existing Claude Code login (or `ANTHROPIC_API_KEY`).
- **Codex** — driven via the `codex exec` CLI, using your `codex login`.
- **Gemini CLI** — driven via the `gemini -p` CLI, using your `gemini` login.

Bring whichever agent you already have installed — the extension auto-detects
the ones the bridge reports as available.

## Run it

### Option A — download the app (no Node.js needed)

Grab the standalone binary for your OS from the
[latest release](https://github.com/chatpanel/chatpanel-bridge/releases/latest) —
it bundles its own runtime, so **nothing to install**. Run it once to set it up to
start automatically at login and run in the background:

```bash
# macOS / Linux (make it executable first on macOS)
chmod +x chatpanel-bridge-macos-arm64
./chatpanel-bridge-macos-arm64 --install

# Windows (PowerShell)
.\chatpanel-bridge-windows-x64.exe --install
```

That's it — open the ChatPanel side panel and your agents appear. Manage it with
`--status` (is it set up?) and `--uninstall` (remove auto-start). Run with no flags
to start it once in the foreground instead.

> Until these binaries are code-signed, macOS Gatekeeper / Windows SmartScreen may
> warn on first run (on macOS, right-click the file → **Open**). Signing is on the way.

### Option B — via npm (needs Node.js 18+)

```bash
npx @chatpanel/bridge        # → http://127.0.0.1:4319
```

…then leave it running and open the ChatPanel side panel. Prefer a persistent
command? `npm i -g @chatpanel/bridge` then `chatpanel-bridge`.

Prerequisites (the agents you want to use must already be set up):

- **Claude Code**: be signed in (`claude`) or set `ANTHROPIC_API_KEY`.
- **Codex**: `codex` on your `PATH` and `codex login` done.

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

`/chat` streams Server-Sent Events: `{type:'delta',text}` as the answer is
generated, `{type:'tool',name,summary}` / `{type:'status'}` for activity, and a
final `{type:'done'}` (or `{type:'error',error}`).

`options` per agent (set in ChatPanel Settings):

```jsonc
{
  "workingDir": "/path/to/project",   // where the agent reads/works
  "permissionMode": "default",         // default | acceptEdits | bypassPermissions
  "model": ""                          // optional model override
}
```

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
