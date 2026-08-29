#!/usr/bin/env bash
set -euo pipefail

bridge_url="${CHATPANEL_BRIDGE_URL:-http://127.0.0.1:4319}"
token_file="${CHATPANEL_BRIDGE_TOKEN_FILE:-${HOME}/.chatpanel/bridge-token}"
prompt="${*:-Reply with exactly: httpie-codex-ok}"

if ! command -v http >/dev/null 2>&1; then
  echo 'HTTPie is required. Install it with: brew install httpie' >&2
  exit 1
fi

if [[ ! -r "$token_file" ]]; then
  echo "Bridge token is not readable: $token_file" >&2
  exit 1
fi

bridge_token="$(tr -d '\r\n' < "$token_file")"
if [[ -z "$bridge_token" ]]; then
  echo "Bridge token is empty: $token_file" >&2
  exit 1
fi

response="$({
  http --check-status --ignore-stdin --body POST "$bridge_url/v1/responses" \
    Authorization:"Bearer $bridge_token" \
    model=codex \
    input="$prompt"
})"

if command -v jq >/dev/null 2>&1; then
  jq -r '.output[]?.content[]? | select(.type == "output_text") | .text' <<< "$response"
else
  printf '%s\n' "$response"
fi
