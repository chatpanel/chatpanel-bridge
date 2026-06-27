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

### macOS / Linux — one line, no Node.js needed

```bash
curl -fsSL https://dl.chatpanel.net/bridge/install.sh | bash
```

Downloads the standalone binary, installs it, and sets it to start at login
(installing via curl avoids the macOS "damaged" prompt). Re-running is a clean
in-place upgrade.

### Windows — via Node (recommended)

Windows SmartScreen flags unsigned downloads, so on Windows run the bridge through
Node — you already have it if you use Claude Code / Codex / Gemini (all npm CLIs),
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
- **Gemini CLI**: `gemini` on your `PATH` and signed in.

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
