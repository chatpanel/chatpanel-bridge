#!/usr/bin/env bash
# ChatPanel Bridge installer - downloads the standalone binary for your OS and
# sets it to start at login. No Node.js required.
#
#   curl -fsSL https://raw.githubusercontent.com/chatpanel/chatpanel-bridge/main/scripts/install.sh | bash
#
# Downloading via curl means the file is NOT quarantined, so macOS won't show the
# "damaged / unidentified developer" prompt that browser downloads trigger.
set -euo pipefail

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

echo "Downloading ${asset} ..."
curl -fsSL "$url" -o "$bin"
chmod +x "$bin"
xattr -c "$bin" 2>/dev/null || true   # belt-and-suspenders; curl files aren't quarantined

# Clean upgrade: stop any running bridge (incl. a stray npx one) so the new
# install replaces it in place — same path, same service, no duplicates.
pkill -f 'chatpanel-bridge' 2>/dev/null || true
sleep 1

echo "Installed to ${bin}"
"$bin" --install
echo
echo "ChatPanel Bridge is running and will start at login."

case ":${PATH}:" in
  *":${dest}:"*) : ;;
  *) echo "Tip: add it to your PATH ->  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac
