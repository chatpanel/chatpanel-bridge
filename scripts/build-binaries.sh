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
  # --external: the optional Claude Agent SDK fallback is off in compiled
  # binaries, so don't bundle it (or its native `sharp`).
  bun build src/server.js --compile --target="$target" --external @anthropic-ai/claude-agent-sdk --outfile "dist/$out"
done
echo "✓ binaries in dist/"
ls -la dist
