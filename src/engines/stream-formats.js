// Stream-format plugins — the seam that makes "add a CLI agent" a DATA change.
//
// Every headless CLI prints its turn in some shape: plain text, or one of a
// handful of NDJSON dialects. Previously each dialect was an inline `else if`
// branch in runSpec(), so a new agent with a new dialect meant editing the
// runner. That's the reinvention this registry removes: a format is a named
// plugin here, and an agent spec just names it (`format: 'copilot-json'`).
//
// Contract — a format is a factory `(emit) => parser` where parser has:
//   push(chunk: string)   feed raw stdout; emit deltas/tools/status as they parse
//   finish(): string      the final answer when nothing was streamed (fallback)
//   get streamed(): bool  true once any delta was emitted
//
// Emitted event types match the bridge's SSE vocabulary: delta | reasoning |
// tool | status. (`done`/`usage`/`error` stay the runner's job.)

import { handleMessage } from './claude.js';

// Many CLIs colourize even when piped; strip ANSI from anything we treat as text.
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

// Shared NDJSON pump: buffers partial lines and hands complete JSON objects to
// `onEvent`. Every JSON dialect below is line-delimited, so they all reuse this.
function ndjson(onEvent) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // a partial/garbage line is not fatal — keep streaming
      }
      onEvent(ev);
    }
  };
}

// --- text ------------------------------------------------------------------
// Anything that just prints a reply.
function textFormat(emit) {
  let streamed = false;
  return {
    push(chunk) {
      streamed = true;
      emit({ type: 'delta', text: stripAnsi(chunk) });
    },
    finish: () => '',
    get streamed() {
      return streamed;
    },
  };
}

// --- claude-stream-json ----------------------------------------------------
// Claude Code's `--output-format stream-json`, parsed by the Claude engine.
function claudeStreamJson(emit) {
  let streamed = false;
  let result = '';
  const pump = ndjson((msg) => {
    const r = handleMessage(msg, emit, streamed);
    if (r.streamed) streamed = true;
    if (r.result != null) result = r.result;
  });
  return {
    push: pump,
    finish: () => result,
    get streamed() {
      return streamed;
    },
  };
}

// --- opencode-json ---------------------------------------------------------
// opencode `run --format json`: text parts, tool events, errors.
function opencodeJson(emit) {
  let streamed = false;
  const pump = ndjson((ev) => {
    if (ev.type === 'text' && ev.part?.text) {
      streamed = true;
      emit({ type: 'delta', text: ev.part.text });
    } else if (ev.type === 'tool' || ev.type === 'tool_use') {
      const p = ev.part || {};
      emit({ type: 'tool', name: p.tool || p.name || p.type || 'tool', summary: '' });
    } else if (ev.type === 'error') {
      const msg = ev.error?.data?.message || ev.error?.message || ev.error?.name || 'error';
      emit({ type: 'status', text: String(msg).slice(0, 300) });
    }
  });
  return {
    push: pump,
    finish: () => '',
    get streamed() {
      return streamed;
    },
  };
}

// --- copilot-json ----------------------------------------------------------
// GitHub Copilot CLI `--output-format json` (verified against 1.0.80).
//
// Event vocabulary (only the ones we surface):
//   assistant.message_delta   data.deltaContent   -> streamed answer text
//   assistant.message         data.content        -> whole answer (fallback)
//   assistant.reasoning       data.content        -> thinking (usually opaque/empty)
//   tool.execution_start      data.toolName       -> activity strip
//   tool.execution_complete   data.success/result -> surface failures
//   session.auto_mode_resolved data.chosenModel   -> which model `auto` picked
//   result                    exitCode/usage      -> terminal event
//
// Copilot reports a denied tool as a COMPLETED call whose result explains the
// permission gap, so a user on a low permission mode otherwise sees a confident
// "I can't do that" with no hint that ChatPanel gated it. Detect that shape and
// say which setting to raise.
const PERMISSION_RE = /permission denied|could not request permission|not allowed|denied by|requires approval/i;

function copilotJson(emit) {
  let streamed = false;
  let result = '';
  let permissionHinted = false;

  const hintPermissions = (text) => {
    if (permissionHinted || !PERMISSION_RE.test(String(text || ''))) return;
    permissionHinted = true;
    emit({
      type: 'status',
      text: 'Copilot was denied a tool/URL — raise this agent’s Permission mode in Settings.',
    });
  };

  const pump = ndjson((ev) => {
    const type = ev?.type || '';
    const d = ev?.data || {};
    switch (type) {
      case 'assistant.message_delta':
        if (d.deltaContent) {
          streamed = true;
          emit({ type: 'delta', text: d.deltaContent });
        }
        break;
      case 'assistant.message':
        // Full turn text. Keep as the fallback answer for the non-streaming case
        // (`--stream off`, or a turn that only produced a final message).
        if (typeof d.content === 'string' && d.content) result = d.content;
        break;
      case 'assistant.reasoning':
        if (d.content) emit({ type: 'reasoning', text: String(d.content) });
        break;
      case 'tool.execution_start':
        emit({ type: 'tool', name: d.toolName || 'tool', summary: '' });
        break;
      case 'tool.execution_complete':
        if (d.success === false) {
          const msg = typeof d.result === 'string' ? d.result : d.result?.error || d.result?.message || '';
          if (msg) emit({ type: 'status', text: String(msg).slice(0, 300) });
          hintPermissions(msg);
        } else {
          hintPermissions(typeof d.result === 'string' ? d.result : '');
        }
        break;
      case 'session.auto_mode_resolved':
        if (d.chosenModel) emit({ type: 'status', text: `model: ${d.chosenModel}` });
        break;
      case 'session.mcp_server_status_changed':
        // Only worth surfacing when our own browser-tool server fails to attach.
        if (d.status === 'failed' && d.error) {
          emit({ type: 'status', text: `MCP ${d.serverName}: ${String(d.error).slice(0, 160)}` });
        }
        break;
      case 'result':
        // Terminal event; `exitCode` is authoritative for failure (the process
        // can still exit 0 while a tool failed). Surface a non-zero code.
        if (ev.exitCode) emit({ type: 'status', text: `copilot exited ${ev.exitCode}` });
        break;
      default:
        break;
    }
  });

  return {
    push: pump,
    finish: () => result,
    get streamed() {
      return streamed;
    },
  };
}

// The registry. Adding a dialect = adding one entry here; agent specs reference
// it by name, so no runner change is needed.
export const STREAM_FORMATS = {
  text: textFormat,
  'claude-stream-json': claudeStreamJson,
  'opencode-json': opencodeJson,
  'copilot-json': copilotJson,
};

export function createStreamParser(format, emit) {
  const make = STREAM_FORMATS[format] || STREAM_FORMATS.text;
  return make(emit);
}
