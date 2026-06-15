#!/usr/bin/env bash
# Compile the bridge into standalone, single-file binaries (no Node required to
# run them). Needs Bun: https://bun.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/chatpanel-bridge-*

targets=(
  "bun-darwin-arm64:chatpanel-bridge-macos-arm64"
  "bun-darwin-x64:chatpanel-bridge-macos-x64"
  "bun-linux-x64:chatpanel-bridge-linux-x64"
  "bun-windows-x64:chatpanel-bridge-windows-x64.exe"
)
for t in "${targets[@]}"; do
  target="${t%%:*}"; out="${t##*:}"
  echo "→ building dist/$out ($target)"
  bun build src/server.js --compile --target="$target" --outfile "dist/$out"
done
echo "✓ binaries in dist/"
ls -la dist
