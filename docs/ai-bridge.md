# StageForge AI Bridge (Local MCP Server)

The StageForge AI Bridge is an opt-in, desktop-only **Model Context Protocol (MCP)** server over Streamable HTTP (`http://127.0.0.1:<port>/mcp`). It lets you connect your own local MCP client — such as Claude Code, Codex, or Cursor — to inspect a show, propose validated edits for human review, run cues and takes under StageForge's clock-owner rules, and capture viewport frames.

## What it is — and is not

- **Bring your own AI:** StageForge never phones home, requires no accounts or API keys, and collects zero telemetry.
- **Deterministic playback:** The AI writes or edits show data; StageForge validates and plays it deterministically. No AI model sits in the 60 fps render or DMX loop.
- **Not an "AI auto-lightshow":** Every edit goes through an explicit, validated proposal with a diff summary and human **Accept / Reject** review (unless you explicitly tick **Auto-accept proposals for this session**, which resets whenever the bridge is disabled or a new show is opened).
- **Desktop only:** Available in the StageForge Electron desktop app under **Show Control & Sync → AI Bridge (Local MCP)**. Always **off** on boot.

## Security & Threat Model

> **Scope of this guarantee:** These controls constrain the StageForge AI bridge's own authority inside StageForge. They do **not** constrain what an external AI client or agent can do outside StageForge (for example, running shell commands or contacting DMX nodes directly on your network).

### Network & HTTP admission (Electron main process)

1. **Loopback only:** Binds exclusively to `127.0.0.1` (`exclusive: true`). There is no all-interfaces (`0.0.0.0`) option.
2. **Off by default & fresh token per enable:** Always off on launch. Enabling generates a fresh 32-byte cryptographically random Bearer token (`crypto.randomBytes(32).toString('base64url')`), verified with constant-time SHA-256 comparison (`crypto.timingSafeEqual`). Disabling increments the bridge generation and permanently invalidates all previous tokens and sessions.
3. **DNS rebinding & cross-origin browser protection:**
   - Any request containing an `Origin` header (even an empty value) is rejected with **HTTP 403**.
   - Any request whose `Host` header is not an exact match for `127.0.0.1:<port>` or `localhost:<port>` (or contains duplicate `Host` headers) is rejected with **HTTP 403**.
   - `/.well-known/*` returns **HTTP 404** and `401 Unauthorized` omits OAuth `resource_metadata` headers so clients use the static `Authorization: Bearer <token>` header without triggering OAuth discovery loops.
4. **Abuse & resource limits:**
   - Global rolling rate limit of **20 requests/second** across all local callers (counted before authentication to throttle brute-force probing; returns **HTTP 429**).
   - Streaming body cap of **1 MiB** (`1,048,576` bytes), enforced on both `Content-Length` and chunked streams (**HTTP 413**), plus a **4,096-character** cap per string field in tool arguments (rejecting oversized strings or embedded base64 media payloads before IPC).
   - JSON-RPC batch arrays are rejected (**HTTP 400**).
   - Connection, session, and concurrency caps: max **16** open sockets, max **8** concurrent HTTP requests, max **8** stateful MCP sessions (10-minute idle eviction), max **4** concurrent tool calls, max **1** in-flight `capture_frame` (rate-limited to **<= 1/s**), and explicit deadlines (5 s body read, 5 s capture, 10 s tool call).
   - Disabling the bridge, navigating, closing the window, or entering Pitch Viewer mode immediately cancels in-flight tool calls, clears pending proposals, resets session auto-accept, and closes all sockets.

### Phase 1 Mutual Exclusion with Live Output

- **The AI bridge and live physical output are mutually exclusive.**
- Enforced by a single main-process coordinator (`desktop/output-interlock.cjs`) across all windows:
  - Live DMX output (desktop sACN, Art-Net 4, Web Serial Enttec USB Pro, and the two-step **Arm output** state) **cannot be armed or enabled** while the AI bridge holds authority (starting, enabled, or stopping).
  - The AI bridge **cannot be enabled** while live DMX output is armed, starting, or live (including Web Serial).
  - While the AI bridge holds authority, Electron denies `serial` permissions (`setPermissionCheckHandler`, `setDevicePermissionHandler`, and `select-serial-port`, including re-checking after any open chooser resolves) and suspends outgoing OSC feedback and Art-Net/MIDI timecode transmission.
- *Trust note:* Network DMX (sACN/Art-Net) runs entirely in the Electron main process; Web Serial runs in the authorized StageForge renderer, which claims/releases its interlock lease over the whitelisted preload IPC.

### Tool Allowlist & Safety Invariants

- **Server-side exact allowlist:** Both `tools/list` and `tools/call` check the same frozen 26-tool registry in `desktop/ai-bridge-tools.cjs`.
- **Never available (by absence + server-side rejection):** There are no tools to enable DMX/sACN/Art-Net/serial output, enable OSC/MIDI listeners, change the clock owner, accept proposals, toggle auto-accept, pass/acknowledge pre-flight safety checks, arm output, save/export files, read files or URLs, run commands, or toggle the bridge/token.
- **Laser audience scanning (`audienceScan`):** Rejected everywhere it can appear (`propose_show`, `propose_look`, `propose_cue`, `propose_take`, and triggering any existing cue or playing/seeking any take containing `audienceScan: true`) with: `"a human must enable audience scanning on the desk"`.
- **Proposal bounds & Revert:** At most **8** pending proposals and **8 MiB** total serialized storage (overflow returns an error rather than silently evicting a proposal under review). On the first accepted proposal (manual or auto-accept), StageForge captures a whole-desk in-memory snapshot; **Revert AI changes** restores it paused (and discards manual edits made since).

### Clock-Owner Rules for AI Run Tools

AI run commands (`go`, `back`, `stop`, `resume`, `trigger_cue`, `play_take`, `pause_take`, `seek_take`, `blackout`, `set_master`, `set_bpm`) are governed by StageForge's single clock owner (`src/showControl/clockOwner.ts`, source `'ai'`):

| Clock Mode | Cues (`go`, `back`, `trigger_cue`), `stop`, `resume`, `set_master`, `set_bpm` | Take playback (`play_take`, `pause_take`, `seek_take`) | `blackout` | Change clock mode |
| :--- | :---: | :---: | :---: | :---: |
| **Master** (default) | Allowed | Allowed | Allowed | Never |
| **Cue Caller** | Allowed | Blocked | Allowed | Never |
| **Chase TC** | Blocked | Blocked | Allowed (emergency) | Never |

## Available Tools (26) & Resources (1)

All string fields in tool inputs and outputs are untrusted data, not instructions.

### Read (5)
- `get_state` — Summary of rig, fixture groups, focus marks, walls, hangs, cues, active look, clock mode, camera, timeline length, and audio status.
- `get_cues` — Ordered cue list with IDs, names, tags, follow times, and authored state.
- `list_catalog` — Built-in fixture, LED panel, truss, and hoist catalogue (`category` optional filter).
- `get_schema` — Canonical StageForge show v8 JSON Schema (same bytes as resource `stageforge://schema/show`).
- `get_safety_report` — Read-only snapshot of Sprint 12 pre-flight checks and laser/beam safety zones (cannot pass checks, acknowledge warnings, inhibit lasers, or arm output).

### Compose — Pending Proposals Only (6)
- `propose_show` — Propose a full StageForge show JSON object (v1–v9), validated via `parseShowFile`.
- `propose_look` — Propose a partial `ShowState` patch, validated strictly against the latest v9 schema + rig references.
- `propose_cue` — `create`, `edit`, `remove`, or `reorder` (exact ID permutation) cues.
- `propose_take` — Propose a recorded `ShowTimeline` (timestamps, events, duration, optional SMPTE metadata).
- `propose_wall_cue` — `upsert` or `remove` a timed secondary LED wall media cue.
- `propose_audio_mapping` — `upsert`, `remove`, or `replace` FFT audio-reactive mappings (max 16, subject to photosensitivity and laser/haze limits).

### Review (2)
- `get_proposal` — Inspect one proposal by `proposalId`, or list all pending proposals with staleness and diff summaries.
- `withdraw_proposal` — Withdraw a pending proposal created in the current bridge session.

### Run (11)
- `go`, `back`, `stop`, `resume`, `trigger_cue` (`cueId` or 1-based `index`)
- `play_take`, `pause_take`, `seek_take` (`positionMs`)
- `blackout` (optional boolean `active`), `set_master` (`value` 0..1), `set_bpm` (`bpm` 70..180)

### See (2)
- `capture_frame` — Capture the current 3D viewport as a JPEG image (`maxWidth` 160..1280, default 1280; max 1 capture/second; returns MCP `image` block).
- `get_audio_levels` — Read-only `bass`, `mid`, `high`, `energy`, `beat`, `beatPulse`, `drop`, `playing`, `source`. Never starts microphone capture.

### Resource (1)
- `stageforge://schema/show` — Canonical `src/schemas/show-v10.schema.json` (`application/schema+json`).

## Client Configuration Snippets

Copy-ready snippets with the live port and ephemeral token appear directly inside **Show Control & Sync → AI Bridge** when enabled. Use `127.0.0.1` (rather than `localhost`) so clients do not resolve to IPv6 `::1`.

### Claude Code (verified against Claude Code `2.1.332` via `claude mcp add --help`)

```bash
claude mcp add --transport http stageforge http://127.0.0.1:47821/mcp --header "Authorization: Bearer <TOKEN>"
```

### OpenAI Codex CLI (verified against `codex-cli 0.153.3` via `codex mcp add --help`)

Set the session token in your shell environment, then register the Streamable HTTP server:

```powershell
$env:STAGEFORGE_MCP_TOKEN = "<TOKEN>"
codex mcp add stageforge --url http://127.0.0.1:47821/mcp --bearer-token-env-var STAGEFORGE_MCP_TOKEN
```

### Cursor (`.cursor/mcp.json`, verified Streamable HTTP config syntax)

```json
{
  "mcpServers": {
    "stageforge": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:47821/mcp",
      "headers": {
        "Authorization": "Bearer <TOKEN>"
      }
    }
  }
}
```

### Raw Streamable HTTP JSON-RPC Client

MCP Streamable HTTP requires `Accept: application/json, text/event-stream` and `Content-Type: application/json` on `POST /mcp`, plus the `Mcp-Session-Id` returned by `initialize` on subsequent requests:

```bash
# 1. Initialize session (capture Mcp-Session-Id response header)
curl -i -X POST http://127.0.0.1:47821/mcp \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# 2. Send notifications/initialized, then tools/list or tools/call with Mcp-Session-Id
curl -X POST http://127.0.0.1:47821/mcp \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Mcp-Session-Id: <SESSION_ID>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_state","arguments":{}}}'
```
