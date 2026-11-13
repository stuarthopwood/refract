# Research: Token guard

Probed 2026-10-23 on omp 18.12.6 (`C:\Users\shopwood\AppData\Local\omp\omp.exe`) in a scratch agent dir (`PI_CODING_AGENT_DIR`) with a dummy `ANTHROPIC_API_KEY`, so no real config, key or running process was touched.

## 1. `--config` overlay
- `omp --help`: `--config=<value>` is "extra config.yml-style overlay for this run, repeatable". Format is the nested YAML of `~/.omp/agent/config.yml` (`compaction:` with `idleThresholdTokens:` under it).
- `omp config get` ignores `--config`, so precedence over a changed global config cannot be proven offline. **Decision**: pass the overlay on every launch and prove precedence in the live verify task (change global config, confirm the Session still shows overlay values).

## 2. `--append-system-prompt`
- Help: "Append text or file contents to the system prompt". It takes **text or a file path**. **Decision**: pass a file path (Refract writes the shipped rules to its data dir each launch), avoiding Windows command-line quoting of about 1.5k characters.

## 3. Can RPC `compact` select a method?
- **No.** The handler is `case "compact": t.compact(r.customInstructions)`; there is no method option. Manual compaction modes are soft, remote and snapcompact only. `{"type":"compact","method":"shake"}` returned "Nothing to compact (session too small)"; `method` is ignored.
- Shake exists as an auto/idle compaction action and as the **`/shake [elide|images|thinking]` slash command**, which calls `session.shake()` with no model call and works over rpc-ui: `{"type":"prompt","message":"/shake"}` returned a `command_output` frame ("Nothing to shake.") and a prompt response with `agentInvoked:false`.
- **Decision**: send `/shake` as a prompt after the turn settles, swallowing the `command_output` frame like `session::advisor::handle_command_output`. The issue's fallback (per-Session overlay making shake the idle-compaction method) is not needed.

## 4. Context and counts
- `get_session_stats` works in RPC (`contextUsage {tokens, contextWindow, percent}`, message counts). Refract already tracks context usage per Session in `session/readout.rs` (`on_sync_from_state`); reuse it.
- Call count: one per completed assistant `message_end` frame.

## 5. Launch shape
- Refract launches `omp --mode rpc-ui --approval-mode=<flag> [--no-session]` (the issue says `rpc`). `build_args` is `process.rs:259`, `connect` is `:281`. `process.rs` is baselined at 1106 lines so the builder is extracted.

## 6. Settings > OMP
- `SettingsScreen.tsx` has no OMP section and #691 is open; the "Guarded" rows of #1184 never shipped. This feature adds the section with "Set by Refract" rows only.

## 7. Shipping the rules file
- Embed with `include_str!("../../resources/refract-rules.md")` and write to the data dir at launch; no Tauri bundle resource or capability change is needed.

## 8. Unverified offline
- Whether the overlay's `modelRoles.advisor` (a record entry, not a settings key in #1184's finding) is honoured by `--config` is not provable offline; the live check (T021) confirms it. If omp ignores it, the fallback is leaving `modelRoles.advisor` to `ipc::model_roles::set_model_role` on explicit Settings change only, and the spec FR-004 entry is amended.

## 9. Does a running OMP reload config live? (#1765 probe, 2026-11-11)
- Probed on omp 18.17.0 (`omp --mode rpc-ui`) in a scratch `PI_CODING_AGENT_DIR` with a local scripted OpenAI-compatible provider; no real config, key or model was touched. The fake model reports 600000 of a 1000000-token window (60%) on every turn, so `compaction.thresholdPercent: 90` stays quiet and `30` compacts.
- Method per case: start omp, send turn one, edit the config while the process keeps running, wait 4 s, send turn two, count `auto_compaction_start` frames.

| Case | Edit between turns | Turn-two compaction frames |
| --- | --- | --- |
| control-global | none (global config at 90) | 0 |
| global-edited | global `config.yml` 90 -> 30 | 4 (two handoff compactions) |
| control-overlay | none (`--config` overlay at 90) | 0 |
| overlay-edited | `--config` overlay file 90 -> 30 | 4 (two handoff compactions) |

- **Finding**: a running OMP re-reads both the global config and a `--config` overlay file between turns, at least for `compaction.thresholdPercent`. Live apply is therefore feasible and FR-008's "a running Session keeps its launch values" no longer holds for that key.
- Not yet probed: which of the other token guard keys are read per turn and which only at startup (extensions, tools, `providers.*`, `plan.defaultOnStartup`, `prewalk.*`). The existing `live` flags in `src/shared/tokenGuard.ts` came from the #1767 probe and need the same running-process check before the label is trusted.
- Current code state: since #1767/#1780 `values::set`, `reset` and `reset_all` write the global config through `omp config set` on Save, so a running Session already sees the new value for live keys. The launch-time overlay is written only for the per-Session plan variant, or for every key while the legacy migration has not succeeded (`args.rs`, `overlay.rs`); in that legacy case a running Session still sees only the old overlay file, and `overlay.rs:1` still says edits apply "next launch".
- Evidence files (scratch, outside the repo): `C:/Users/shopwood/refract-live-check-1765/probe-report.json`, probe scripts in `C:/Users/shopwood/refract-live-check-1765/probe/` (`lib.mjs`, `probe-live-reload.mjs`).

## 10. Per-key running-process probes (#1765, 2026-11-11, omp 18.17.0)
- Same setup as section 9 (scripted local provider, scratch `PI_CODING_AGENT_DIR`, no real model). Scripts: `probe-C.mjs` (compaction keys), `probe-K.mjs` (subagent keys), `probe-S.mjs` (start-of-turn prompt keys), `probe-I.mjs` (snapcompact), in `C:/Users/shopwood/refract-live-check-1765/probe/`; logs `run-S.log`, `run-K.log`.
- **Live (observed by editing the config between turns of a running process)**: `compaction.thresholdPercent` (section 9), `compaction.modelThresholds` (turn one quiet, turn two compacted after the edit), `compaction.methodOrder` (turn one `handoff`, turn two `context-full` after the edit).
- **Carried over, not re-probed here**: `tools.xdev` keeps `live: true` from the #1767 probe.
- **Unverified (no usable observable)**: `compaction.idleEnabled`, `compaction.idleThresholdTokens`, `compaction.idleTimeoutSeconds` (an RPC session starts no idle maintenance: `session.enableIdleMaintenance` is opt-in and only the TUI enables it, per omp `sdk.md`, so no compaction fires in either turn); `task.maxConcurrency` and `task.softRequestBudget` (the scripted model's subagent fan-out was not repeatable between runs, so startup and live runs are not comparable); `plan.defaultOnStartup`, `prewalk.enabled`, `todo.eager`, `autolearn.autoContinue`, `advisor.reviewMode` (system-prompt hashes differ between runs for reasons other than the key, so the A/B is confounded; the S run was stopped before completing); `snapcompact.toolResults`, `snapcompact.systemPrompt`, `grep.contextBefore`, `grep.contextAfter`, `read.defaultLimit`, `read.summarize.enabled`, `tools.artifactSpillThreshold` (not probed).
- **Decision**: a key keeps no `live` flag unless a probe observed it. The four existing flags stay; no flag is added. Every unverified key keeps "Applies to new Sessions" until a later probe proves it live.
- **Superseded by section 11**: the #1935 probes resolved every "unverified" key above; the live set is now sixteen keys.

## 11. Live verdicts for all 17 keys (#1935, 2026-11-12, omp 18.17.0)
- Each probe edited the key with `omp config set` mid-process (turn 1 -> turn 2) in a scripted-provider RPC process against a scratch `PI_CODING_AGENT_DIR`; two consecutive runs agreed and an unchanged control stayed unchanged. Probes: `scripts/token-guard-probe/` (`pnpm probe:token-guard`). Reports and the evidence table are kept outside the repo in `C:/Users/shopwood/refract-1935-probe/` (`verdicts.md`).

| Key | Verdict | Observable (turn 1 -> turn 2) |
|---|---|---|
| grep.contextBefore | live | grep result 1 row -> 4 rows |
| grep.contextAfter | live | grep result 1 row -> 4 rows |
| read.defaultLimit | live | 300 numbered rows -> 50 |
| read.summarize.enabled | live | 120 collapsed bodies -> 0 |
| tools.artifactSpillThreshold | live | 30 KB output spilled at 10 KB -> inline at 100 KB |
| snapcompact.toolResults | live | text only -> image parts in the request |
| snapcompact.systemPrompt | live | text only -> image parts; only for model ids omp knows |
| task.maxConcurrency | live | peak subagent requests 1 -> 3 |
| task.softRequestBudget | live | requests before force-stop 21 -> 39 |
| prewalk.enabled | live | last request model switched to the prewalk model |
| autolearn.autoContinue | live | capture-turn requests 0 -> 1 |
| advisor.reviewMode | live | advisor requests 4 -> 1 |
| todo.eager | startup-only | manual check, not in the committed probes: with the key edited mid-process the "create a phased todo" reminder is absent on the next turn (control and test 0, 0, 0); after the edit then `/new` it appears (0, 0, 1). Steps from `explore4` in `C:/Users/shopwood/refract-1935-probe/`: scratch RPC process, `omp config set todo.eager true`, send a turn, send `/new`, send a turn, count the reminder in system text. A `/new`-only key counts as startup-only (OQ-2) |
| plan.defaultOnStartup | no-effect (RPC) | manual check, not in the committed probes: no plan-mode marker and an identical tool list after the edit, after `/new`, and even with the key set in the scratch `config.yml` before process start (`explore5`); RPC offers no way to enter plan mode. Control unchanged |
| compaction.idleEnabled | no-effect (RPC) | no idle compaction in 75 s; RPC sessions never enable the idle scheduler (omp `sdk.md`) |
| compaction.idleThresholdTokens | no-effect (RPC) | same observation |
| compaction.idleTimeoutSeconds | no-effect (RPC) | same observation |

- Together with `compaction.thresholdPercent`, `compaction.modelThresholds`, `compaction.methodOrder` (section 10) and `tools.xdev` (#1767) the live set is 16 keys.
- **OQ-1 (decided 2026-11-12)**: the four no-effect keys have no effect in a Refract (RPC) Session. They are recorded here and in the PR body; hiding or relabelling those rows is tracked in a separate issue, not this PR.
