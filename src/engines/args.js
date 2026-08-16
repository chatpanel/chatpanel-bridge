// Caller-supplied "extra CLI arguments" sanitizer (shared by every engine).
//
// The extension/model can pass free-form extraArgs to the agent CLI. A prompt-
// injected model must NOT be able to smuggle a flag that re-opens the sandbox /
// permission boundary the engine deliberately sets (e.g. Codex's
// --dangerously-bypass-approvals-and-sandbox, Claude's --permission-mode). Since
// these flags take values, partial filtering is unsafe — if ANY forbidden token is
// present we drop the WHOLE extraArgs. Previously only claude.js did this; codex,
// antigravity and custom pushed extraArgs unfiltered (this closes that gap).

export function splitArgs(raw) {
  return String(raw || '').split(/\s+/).filter(Boolean);
}

// Per-engine escalation flags. Long flags use \b so `--flag=value` is caught too;
// short flags are exact-matched so we don't over-block a benign token.
export const FORBIDDEN = {
  claude: /^--?(permission-mode|allowed-?tools|disallowed-?tools|dangerously|add-dir|mcp-config|setting-sources|permission-prompt-tool)/i,
  // Codex: sandbox / approval escalation + `-c key=val` (can set approval_policy or
  // sandbox_mode in TOML) + `-C/--cd` (retarget the working dir).
  codex: /^(-s|-a|-c|-C)$|^--(dangerously[\w-]*|sandbox|ask-for-approval|full-auto|yolo|config|cd)\b/i,
  antigravity: /^--(dangerously[\w-]*|skip-permissions|trust-all-?tools|yolo|full-auto)\b/i,
  // Custom runs an arbitrary CLI, so only clearly-dangerous LONG flags are blocked
  // (no short-flag guesses that might collide with a benign tool option).
  custom: /^--(dangerously[\w-]*|skip-permissions|trust-all-?tools|no-sandbox|bypass|yolo|full-auto|permission-mode|allowed-?tools|disallowed-?tools|mcp-config)\b/i,
  // Copilot's escalation surface is its own family of --allow-* flags (which the
  // `custom` pattern above does NOT cover: "allow-all-tools" != "allowed-tools").
  // Also block re-targeting the working dir (-C / --add-dir) and injecting MCP
  // servers, since the engine sets those deliberately per turn.
  copilot: /^(-C)$|^--(allow-all[\w-]*|allow-tool|allow-url|allow-path|yolo|add-dir|additional-mcp-config|disable-builtin-mcps|deny-tool|deny-url|autopilot|mode)\b/i,
};

// Returns { args, blocked }. `blocked:true` => the whole extraArgs was dropped.
export function sanitizeExtraArgs(raw, forbidden) {
  const tokens = splitArgs(raw);
  if (tokens.some((t) => forbidden.test(t))) return { args: [], blocked: true };
  return { args: tokens, blocked: false };
}

// Convenience for the engines: sanitize, push the safe tokens onto `args`, and emit
// a status when something was dropped.
export function pushExtraArgs(args, raw, forbidden, emit) {
  if (!raw) return;
  const { args: extra, blocked } = sanitizeExtraArgs(raw, forbidden);
  if (blocked) { try { emit?.({ type: 'status', text: '(ignored unsafe extraArgs)' }); } catch { /* ignore */ } return; }
  args.push(...extra);
}
