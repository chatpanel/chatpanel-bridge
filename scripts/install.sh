#!/usr/bin/env bash
# ChatPanel Bridge installer - downloads the standalone binary for your OS and
# sets it to start at login. No Node.js required.
#
#   curl -fsSL https://raw.githubusercontent.com/chatpanel/chatpanel-bridge/main/scripts/install.sh | bash
#
# Add the optional privacy gateway (redaction, model routing, voice) in the same flow:
#   curl -fsSL https://dl.chatpanel.net/bridge/install.sh | bash -s -- --gateway
#
# Downloading via curl means the file is NOT quarantined, so macOS won't show the
# "damaged / unidentified developer" prompt that browser downloads trigger.
set -euo pipefail

# --gateway also installs the ChatPanel Privacy Gateway — the optional upgrade that adds
# PII redaction, model routing and voice in front of everything the bridge does. The bridge
# is the common case and is always installed; the gateway is opt-in and heavier.
WITH_GATEWAY=0
for a in "$@"; do
  case "$a" in
    --gateway|--with-gateway) WITH_GATEWAY=1 ;;
  esac
done

os="$(uname -s)"
arch="$(uname -m)"
asset=""

case "$os" in
  Darwin)
    if [ "$arch" = "arm64" ]; then
      asset="bridge/macos-arm64"
    else
      echo "Intel Mac detected - no x64 binary yet. Use:  npx @chatpanel/bridge  (needs Node.js 18+)"
      exit 1
    fi
    ;;
  Linux)
    asset="bridge/linux-x64"
    ;;
  *)
    echo "Unsupported OS ($os). Use:  npx @chatpanel/bridge  (needs Node.js 18+)"
    exit 1
    ;;
esac

url="https://dl.chatpanel.net/${asset}"
dest="${HOME}/.local/bin"
bin="${dest}/chatpanel-bridge"
mkdir -p "$dest"
tmp="$(mktemp "${dest}/.chatpanel-bridge.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

echo "Downloading ChatPanel Bridge (~60 MB)..."
curl -fL --progress-bar "$url" -o "$tmp"   # show a progress bar (not silent)
chmod +x "$tmp"
xattr -c "$tmp" 2>/dev/null || true   # belt-and-suspenders; curl files aren't quarantined

# Clean upgrade: stop any running bridge (incl. a stray npx one) so the new
# install replaces it in place — same path, same service, no duplicates.
pkill -f 'chatpanel-bridge' 2>/dev/null || true
sleep 1
rm -f "$bin"
mv "$tmp" "$bin"
trap - EXIT

echo "Installed to ${bin}"
"$bin" --install
echo
echo "ChatPanel Bridge is running and will start at login."

case ":${PATH}:" in
  *":${dest}:"*) : ;;
  *) echo "Tip: add it to your PATH ->  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

if [ "$WITH_GATEWAY" = "1" ]; then
  echo
  echo "Adding the ChatPanel Privacy Gateway (optional upgrade)..."
  # One download story: the gateway installer lives at the same dl host. A gateway failure
  # must not fail the bridge install — the bridge is already up.
  if curl -fsSL https://dl.chatpanel.net/gateway/install.sh | bash; then
    echo "Gateway installed. One MCP config now gives any CLI your history + skills, redacted:"
    echo "    chatpanel-gateway mcp"
  else
    echo "Gateway install didn't complete — the bridge is unaffected. Retry any time:"
    echo "    curl -fsSL https://dl.chatpanel.net/gateway/install.sh | bash"
  fi
else
  echo
  echo "Optional upgrade — the Privacy Gateway adds PII redaction, model routing and voice,"
  echo "and lets any CLI (Codex, Claude Code) reach your history + skills through one MCP server:"
  echo "    curl -fsSL https://dl.chatpanel.net/gateway/install.sh | bash"
  echo "  (or re-run this with --gateway to add it now.)"
fi
