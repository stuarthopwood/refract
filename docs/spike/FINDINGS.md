# OMP transport spike findings

## Environment
- omp: omp/18.4.4 (standalone compiled binary); `@oh-my-pi/pi-coding-agent@18.4.4` installed via `bun add` in a scratch dir, exact version match.
- bun 1.4.0, node v26.10.0. Model `@smol` resolved to `gpt-5.6-luna` via github-copilot.
- Fixtures: `wtA` (README "worktree A"), `wtB` (README "worktree B").
- The raw frame logs and per-transport result files stay in the local scratch dir of the person who ran the spike (they contain personal skill names and chat text); this document is the shareable summary. `btw-ext.ts` next to this file is the proven side-chat extension.
- `resume-probe.mjs` next to this file reproduces C16 for RPC: `node docs/spike/resume-probe.mjs` (Node 22+, `omp` on PATH or `PINION_OMP`). Raw frames stay in a temp scratch dir.
- Caveat: three probes ran concurrently on the same machine, so timing numbers (C22) are inflated and only comparable relative to each other, not absolute.

## Matrix
Legend: PASS / FAIL / n-a / unv (unverified).

| ID | Check | RPC | RPC-UI | ACP | SDK |
|---|---|---|---|---|---|
| C1 | Full features load (skills, extensions, MCP) | PASS (224 cmds; user MCP tools listed) | PASS (same launch) | PASS skills+ext; MCP unv (reply "NONE") | not tested (SDK defaults) |
| C2 | Slash coverage | 224 cmds; ABSENT: plan fork resume settings btw pause plan-review new | same | same 224; same absences | n/a |
| C3 | Slash execution | PASS (`/compact`, `/marketplace`: `agentInvoked:false`, text via `command_output`, ordering not fixed) | same | PASS `/compact` | PASS `/compact` |
| C4 | `/btw` as side channel | FAIL: falls through as a normal turn (messages 10 -> 12) | FAIL | FAIL: persisted into main transcript | FAIL: messages 14 -> 16 |
| C18 | `/btw` via extension `runEphemeralTurn` | PASS idle and mid-stream, zero history change | n-a | not tested | not tested |
| C5 | steer / abort | PASS (abort ack != idle; wait for `session_settled`) | n-a | not tested | not tested |
| C6 | subagent frames | PASS (`set_subagent_subscription`; 42 frames) | n-a | PASS as `tool_call_update` progress on the `task` tool (no dedicated type) | FAIL: only `tool_execution_*` for `task` |
| C7 | session ops | PASS `get_state`, `new_session`, `switch_session` (`sessionPath`); `branch` FAIL "Invalid entry ID" (contract unresolved) | n-a | n-a | n-a |
| C8 | Approval dialog | n-a | PASS: `extension_ui_request` method `select`, options Approve/Deny | PASS: `session/request_permission` (allow_once/allow_always/reject_once/reject_always) | FAIL: no hook, fails closed |
| C9/C14 | `ask` tool | n-a | PASS as `select` with `optionDetails` (text-only, no headers/previews/notes/images) | PASS mechanism as `elicitation/create` form, but turn ended `stopReason: cancelled`, no confirmation text (repro 2x, only with @smol tried) | FAIL: crashes `theme.status` with stub UI context |
| C10 | widgets/status | n-a | only `setWidget` seen (fire and forget) | n-a | n-a |
| C11/C19 | Two sessions, one process | n-a | n-a | PASS (one PID, distinct cwds) | PASS (one Bun process) |
| C12 | Available commands | n-a | n-a | PASS (`available_commands_update`) | n-a |
| C13 | Permission gate | n-a | n-a | PASS (needs explicit `--approval-mode always-ask`; global config here is yolo) | see C8 |
| C15 | fs bridge | n-a | n-a | PASS: server calls client `fs/write_text_file` (UI can preview/intercept) | n-a |
| C16 | Resume after restart | PASS: a fresh process reattaches a session written by a process killed with `taskkill /T /F`, via `switch_session`, `--resume <file>`, and `open_session`; history intact (message count and codeword match), the next prompt continues it and appends to the same file. All three routes were tested on isolated byte copies of the seed session; `--resume` was also tested on the original, unmodified file in its original dir (a true same-file restart). `open_session` skips a newer empty session in favour of the newest non-empty one (`resume-probe.mjs`, 2026-09-30, omp 18.4.4) | n-a | FAIL: `session/load` and `session/resume` return "ACP session not found" for prior-process sessions despite advertised capability | not tested |
| C17/C20 | Event fidelity | rich (RPC events + subagent frames) | same | text, thought, tool_call(+update), plan, usage_update, config/session_info/commands updates | text, thinking, tool_execution, usage/cost, advisor; no subagent stream |
| C22 | Cold start, first token (median) | ~15.0 s (fresh process each run) | n-a | not measured | ~8.0 s (warm registry, in-process). NOT comparable: different warm-up, includes model latency, measured under heavy concurrent load. Not evidence for or against the SDK. |
| C22b | Runs under plain Node | n-a | n-a | n-a | FAIL: package main is raw `.ts` under node_modules; Bun required |
| C23/C24 | Windows lifecycle | PASS: `taskkill /PID /T /F` clears tree, no orphans; stdin close -> exit 0 in 2.2 s | n-a | PASS: same, exit 0 | PASS (clean dispose) |

## Selection rule result
Rule 1 (prefer rpc-ui if C1, C3, C4-or-C18, C8, C9 pass and C7 works): C1 PASS, C3 PASS, C18 PASS (C4 native FAIL, fallback works), C8 PASS, C9 PASS, C7 core ops PASS (`branch` unresolved). **Selected transport: `omp --mode rpc-ui`, one process per session/worktree, full-feature launch.**

Why not the others:
- ACP: session ids do not survive process restart (C16), so the session list/switcher cannot reattach after an app relaunch; `/btw`, `/plan`, `/fork`, `/resume`, `/new`, `/settings` are also missing; `ask` turn cancelled unexpectedly. Its wins: multi-session per process, native permission/elicitation forms, fs write bridge for diff preview.
- SDK: cannot surface tool-approval prompts at all (C21, `createAgentSession` never calls `ExtensionRunner.initialize`), `ask` crashes with a stub UI, no subagent events, and needs a Bun sidecar because Node cannot import it. Its win: no per-session process spawn, faster warm start.

## Consequences for the desktop app (chosen transport: rpc-ui)
1. **Commands the UI must supply natively or drop** (absent over RPC): `/plan`, `/fork`, `/resume`, `/new`, `/settings`, `/pause`, `/plan-review`, `/btw`. `/new` and `/resume` map to `new_session` and `switch_session`/`open_session`. `/btw` maps to an extension command built on `ctx.runEphemeralTurn` (proven, C18); the app should ship that extension and NOT forward literal `/btw ...` (it silently becomes a normal, persisted turn).
2. **Available over RPC and worth surfacing:** `/model /compact /handoff /move /marketplace /reload-plugins /todo /usage /context /mcp /jobs /session /wt /add-dir /dirs`, plus 175 `skill:*` commands and extension/custom/file commands. `/wt` (a built-in) may cover worktree operations: unverified, test before designing worktree creation UI around it.
3. **Dialog handling:** both approvals and `ask` arrive as generic `select` requests. The UI must tell them apart by title prefix `Allow tool:` versus everything else, and `ask` loses headers, previews, notes, and images over RPC.
4. **Host gotchas seen live:**
   - Prompt payload field is `message`. `text` is silently accepted and returns `success:false` with an opaque TypeError.
   - Local-only slash commands (`agentInvoked:false`) emit no `prompt_result`; `command_output` can arrive before or after the ack.
   - After `abort`, wait for `session_settled` before sending another prompt, else "Agent is already processing".
   - Unknown `/foo` text is not rejected; it goes to the model as a normal prompt.
   - `branch` needs an entry id contract that was not resolved.
5. **Left pane:** RPC has no list-sessions command in the frames observed; list sessions by scanning JSONL files in the session dir and reattach with `--resume <sessionFile>` at spawn, `switch_session {sessionPath}`, or `open_session {sessionDir}` (all passed C16). Confirmed by the probe:
   - `switch_session` to a missing path returns `success: true, cancelled: false` and starts an empty session (`messageCount: 0`), so confirm every reattach with `get_state` `sessionFile` and `messageCount`.
   - Spawning `omp --mode rpc-ui --session-dir <dir>`, and attaching by any of the three routes, creates no new `*.jsonl` file; the session file is created lazily, so scanning the dir does not accumulate empty entries. (The one exception is the missing-path `switch_session` above, which creates a file at that exact path.)
   - `open_session {sessionDir}` picks the newest non-empty session even when a newer empty one exists.
   - The process cwd must be the session's own worktree. `switch_session` to a session recorded under a different cwd returned `success: true, cancelled: true` and left the process on a fresh empty session (`messageCount: 0`), so spawn each session's process with that worktree as its cwd.
   - OMP rewrites the session file on reopen, so byte size can shrink (one run: 36292 -> 25972 bytes). The only difference found is that `providerPayload` (provider-side replay state, ~5-6 KB per assistant entry) is dropped; visible text and tool calls are byte-identical. The recall check shows the conversation still continues, but the provider's hidden reasoning chain does not carry across a reopen, and the first turn after it may lose prompt-cache hits. Do not detect changes by file size; count entries.
   Kill process trees with `taskkill /PID <pid> /T /F`.
6. **Cold start:** ~15 s to first token from a fresh full-feature process (inflated by concurrent load). The app should spawn one process per session ahead of use and keep it warm; verify the number on an idle machine before designing around it.
7. **Config note:** the test machine's global `tools.approvalMode` was yolo; an app that wants an approval UI must pass `--approval-mode=always-ask` explicitly.
8. **Bun requirement:** rpc-ui needs no Bun in the app (child process over stdio); only the SDK path would.
9. **Parent death (Windows):** when the parent process was killed with `taskkill /F` (no `/T`), `omp --mode rpc-ui` exited by itself within 2 s, both idle and mid-answer (probe: throwaway script, 2026-09-30). The case of a running tool's subprocess (for example `bash` running `ping`) was not resolved: other `omp` processes on the machine polluted the process listing. Treat leftover tool subprocesses as unverified and do not rely on this for cleanup; record spawned pids and reap on next start.

## Open items not covered by the spike
- MCP over ACP unverified (RPC listed the tools).
- `ask` cancellation in ACP tried with `@smol` only.
- `branch` entry id rule.
- `/wt` behaviour.
- Cold start on an idle machine.
- MCP loading was judged from a cheap model listing its tools. Re-check deterministically with the `/mcp` built-in or a `tool_execution_start` frame for a named MCP tool.
- Sub-finding to keep: Copilot desktop creates one git worktree per session under `<repo-clone>/../copilot-worktrees/<repo>/<user>-<adjective>-<noun>` (verified on disk), which is the UX Pinion is meant to match.
