# Contract: renderer to main (typed IPC) — Session readout additions

Extends spec 001's contract (`specs/001-core-session-workspace/contracts/ipc.md`); only new or
changed channels are listed here. Everything else (the `Result<T>` envelope, error codes,
`repositories.*`, `sessions.*` other than the one field noted below, `conversations.*`,
`chat.send`/`chat.stop`/etc., `settings.get`/`setApprovalMode`) is unchanged and not repeated.

## Requests

### Settings (FR-012 to FR-014)

| Method | Returns | Notes |
|---|---|---|
| `settings.setReadoutVisibility(kind, visible)` | `Settings` | `kind: ReadoutKind`. Persists the whole `Settings` row (data-model.md migration rule) and returns this call's own written value, the same race-safety rule `setApprovalMode` already documents (spec 001 `src/main/store/settings.ts`). Pushes `settings:changed` exactly like `setApprovalMode` — no new event. |

### Sessions (FR-001 to FR-010) — one field added to an existing return type

| Method | Returns | Notes |
|---|---|---|
| `sessions.open(id)` / `sessions.recover(id)` / `conversations.startNew(id)` / `conversations.open(id, file)` | `SessionSnapshot` (spec 001), now `{ runtime, conversations, readout, subagents }` | `readout: SessionReadout` (data-model.md) is the initial bundle for the chip row; subsequent changes arrive only via `readout:update` (below), mirroring how `transcript:patch` follows the initial transcript in `runtime`. `subagents: SubagentSummary[]` is the current turn's subagent list as of this snapshot (the same shape `subagents:update` pushes), seeding the Subagent panel so re-applying a snapshot (a session switch, a view round-trip that remounts `ChatPane`) never wipes an already-running or already-finished turn's list back to empty while `readout.subagentCount` still shows it; subsequent changes still arrive only via `subagents:update`. |

Changes chip data itself is **not** a new request: it is exactly spec 001's
`sessions.diffStat(id)`, called by main (not the renderer) to assemble `SessionReadout.changes`,
and also still directly callable by the renderer wherever spec 001 already calls it (the Session
details card). This spec adds no new diff-counting entry point.

### Subagents (FR-017 to FR-020)

| Method | Returns | Notes |
|---|---|---|
| `chat.setVisibleSubagent(sessionId, subagentId \| null)` | `void` | Tells main which subagent's stream to forward as `subagent:patch`; `null` stops forwarding (panel closed, or no subagent selected). Mirrors `sessions.setVisible` (spec 001). |
| `chat.subagentSnapshot(sessionId, subagentId)` | `TranscriptItem[]` | Full current stream for one subagent, for when the panel first selects it (before patches arrive). Error `not-found` when the id does not match a `SubagentSummary` of the current turn. |

## Events (main to renderer)

| Event | Payload | Purpose |
|---|---|---|
| `readout:update` | `{ sessionId, readout: SessionReadout }` | The chip row's live data (data-model.md). Coalesced to at most one per 50 ms per Session, same discipline as `transcript:patch`; sent only for the Session the user is viewing, plus a full value when a Session becomes visible (folded into `SessionSnapshot.readout` above, so no separate "reset" shape is needed here). |
| `subagents:update` | `{ sessionId, subagents: SubagentSummary[] }` | The current turn's subagent list, for the Subagents chip's count and the panel's list. Replaces the whole array each time (small, bounded by one turn's subagent count — no patch/op shape needed). |
| `subagent:patch` | `{ sessionId, subagentId, ops: TranscriptOp[] }` | The selected subagent's live stream, using the same `TranscriptOp` shape as `transcript:patch` (spec 001). Sent only for the subagent named by the Session's last `chat.setVisibleSubagent` call. |

`settings:changed` (spec 001) is unchanged in shape (`Settings`) and now also carries
`sessionReadout`; no new event is added for Settings changes.

## Errors

No new `IpcErrorCode` values beyond `not-found` (already defined by spec 001, reused above for an
unknown `subagentId`). A pull request lookup failure or unavailable GitHub access is never
surfaced as an IPC error (FR-006, SC-007): it simply leaves `SessionReadout.pullRequest` at its
last value (or `null` if never read), with no error returned from any request in this contract.
