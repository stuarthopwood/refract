# Feature Specification: Degraded-only agent health readouts

**Feature Branch**: `readout-quiet-by-default`
**Status**: Draft
**Input**: #561 "Readout: RPC latency and agent memory shown only when degraded (quiet by default)". Numbered 044: 043 is claimed by another lane. Triage routed it as converge; Stuart's director brief requires the full specify route, so it is its own spec. It consumes spec 004 (Status line) and the #560 low-memory notice without amending them.

## Clarifications

### Session 2026-10-29 (grill, Skippy delegated by Stuart; recorded on #561, ui-architect-v3 rulings)

- Q: What is already delivered? A: the system-wide low-memory notice under the profile item (#560, `memory:warning`). Per-agent memory and RPC latency are not.
- Q: What does "RPC slow" mean? A: two consecutive quick-command round trips at or above 2.0 s, or one at or above 5.0 s. It clears on a sample under 1.0 s or after 60 s with no sample; between 1 s and 2 s the state holds. Minimum display 10 s.
- Q: Which commands are sampled? A: `get_state`, `get_session_stats`, `abort`, `set_thinking_level`. Never `prompt`, `compact` or anything that streams or runs long.
- Q: What is "agent memory"? A: the working set of the Session's OMP process (one process per Session). Enter at 1.5 GB or more, clear below 1.25 GB, decimal GB.
- Q: Settings toggle or pin-on? A: neither. No Settings gate, no per-kind Settings rows, not added to `READOUT_KIND_ICONS`.
- Q: Placement? A: after the Long conversation readout, before the right-aligned Current time; RPC then memory; no reserved space while healthy.
- Q: Interaction? A: read-only, no box, no action link, no Stop action. The #560 notice stays the one action surface.
- Q: Announcement? A: a hidden always-mounted `role="status"` per readout; only on entering degraded; at most once per five minutes per Session and measure; the Session name is included in a Split.
- Q: Network, CSP, capability (Principle V)? A: none; the event reuses the existing Tauri event channel and the Rust side reads only a process we spawned.
- Clarify pass (self-answered): no further ambiguity that changes the implementation.

## Requirements

- **FR-001** While a Session's agent is healthy, the Status line shows no RPC or memory readout, reserves no space, and no `session:health` event is sent for it.
- **FR-002** `omp::process` records the request-to-response time of the tracked quick commands as the latest sample plus a slow streak; no history, no polling, no extra RPC.
- **FR-003** `session::health` evaluates every live Session every 5 s with the thresholds in the clarifications, including hysteresis and the 10 s minimum display, and emits `session:health { sessionId, rpcSlowMs, agentMemoryBytes }` (a `null` field means healthy) only when a measure enters or leaves its degraded state, plus a 15 s repeat while degraded. Only visible Sessions emit.
- **FR-004** Agent memory is the OMP process working set read through Win32 `GetProcessMemoryInfo` on a `PROCESS_QUERY_LIMITED_INFORMATION` handle that is closed on every path. On other platforms it reads nothing and the memory readout never appears.
- **FR-005** The renderer keeps `session-health-store` per Session; a Session with both fields null has no entry.
- **FR-006** `RpcSlowReadout` shows "RPC slow, 2.4 s" and `AgentMemoryReadout` shows "Agent memory high, 1.8 GB": muted text with an icon, no box, no action. Each is a focusable no-op button with a tooltip and the full phrase as its accessible name ("2.4 seconds", "1.8 gigabytes"); tooltip text as in the #561 decision comment.
- **FR-007** Each pane reads its own Session. A hidden `role="status"` per readout announces only on entering degraded after the first value, at most once per five minutes per Session and measure, naming the Session in a Split.
- **FR-008** Debug builds only: `REFRACT_FORCE_RPC_SLOW_MS` and `REFRACT_FORCE_AGENT_MEMORY_BYTES` force each degraded state for the live check. Release builds contain neither.
- **FR-009** No new Settings, no new IPC request, no capability or CSP change.

## Success criteria

- `pnpm ci:local` is green on the merged tree; the live check on a scratch exe shows both readouts appear with the force hooks, stay absent without them, and clear.
- No file grows past its `scripts/file-size-baseline.json` value (`omp/process.rs`, `shared/ipc.ts` included); new files stay under 600 lines; reusable components only (ADR 0003).
- No new tests (prototyping phase); existing tests keep passing.
