# T14 probe notes: parked subagent wire string (#1098)

Date: 2026-10-29. OMP: `omp/18.13.3` (`%LOCALAPPDATA%\omp\omp.exe`, a Bun-compiled single binary).

## Method

Static inspection of the installed binary's embedded RPC schema and registry source. No live model
run: the schema is authoritative for the wire enum and a live run costs a real model call. Strings
extracted by scanning the binary as Latin-1 text.

## Findings

| Wire element | Values |
|---|---|
| `set_subagent_subscription` params | `{ level }`, `level` is `'off' \| 'progress' \| 'events'`; result `{ level }`; error `Subagent event bus is unavailable` |
| `subagent_lifecycle` frame | `{ type: 'subagent_lifecycle', payload }`, sent at level `progress` or `events`; payload carries `SubagentLifecycleStatus` |
| `SubagentLifecycleStatus` | `'started' \| 'completed' \| 'failed' \| 'aborted'` |
| `SubagentStatus` (`get_subagents` snapshot) | `'pending' \| 'running' \| 'completed' \| 'failed' \| 'aborted'` |
| `get_subagents` doc string | "List running subagents" |

`parked` and `idle` exist only in OMP's internal agent registry (`agent-registry.ts`:
`status` of `running | idle | parked | aborted`, where a parked agent has `session: null` and a
`sessionFile`) and its TUI. Neither string appears in any RPC enum: the lifecycle bus drops an
agent from its in-memory set on a terminal status (`completed`, `failed`, `aborted`) and
emits only those four statuses.

## Conclusion

No reliable wire string for a parked or idle subagent in `subagent_lifecycle` or `get_subagents`
on 18.13.3. A parked agent is indistinguishable on the wire from a `completed` one, so mapping
`completed` to `parked` would be a guess. T15 therefore ships the renderer vocabulary only; no
Rust subscription. #1098 stays open.

## What is missing

An RPC-visible parked signal from OMP: either a `parked` (or `idle`) member in
`SubagentLifecycleStatus` and `SubagentStatus`, or a registry roster query. Re-run this probe
(grep the binary for `SubagentLifecycleStatus`) on each OMP upgrade.
