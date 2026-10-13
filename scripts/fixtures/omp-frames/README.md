# Recorded-frame `omp` fixtures

Fixtures for `scripts/verify-tauri-fake-omp.mjs` (issue #795 part 2, R12a). Each `.jsonl` file is
a strict **linear tape**: the engine starts at the first line and works down it, one frame at a
time, pausing only at a `__wait__` line until a matching command arrives from the real caller
(the Rust build's `omp::process::OmpProcess`, or a direct script talking to the fake `omp` the
same way).

## Tape syntax

Every non-comment line is JSON. Three shapes:

- An ordinary OMP wire frame (has a `type` field): emitted verbatim, after substituting any of the
  three sentinels below.
- `{"__wait__": ["type1", "type2", ...]}`: pause until the next command read from stdin has a
  `type` in this list; anything else is logged to stderr and dropped (a fixed-script replay, not a
  model, so it cannot answer a command it was not written to expect). Resolving a wait sets the
  sentinels for every frame that follows, until the next wait resolves.
- `{"__exit__": {"code": <number>}}`: exit the process immediately with this code. Simulates `omp`
  crashing or exiting unexpectedly.

**Every fixture's second step (right after `ready`) is the `negotiate_protocol` handshake**
(`__wait__: ["negotiate_protocol"]` then its `response`): `omp::process::OmpProcess` sends this
unconditionally for every connection once `ready.supportedProtocolVersions` includes 2
(contracts/omp-usage.md "Start-up sequence per Session" step 2), before any other command --
omitting it stalls the real caller until its 60s/180s ready-wait ceiling with no visible error.

### Sentinels

Substituted as a bare string value only (never inside a longer string), anywhere in a frame:

| Sentinel | Set when a wait resolves on... | Value |
|---|---|---|
| `$lastId` | any command | that command's own `id` |
| `$turnId` | a `prompt` command | that command's own `id` (stays set across the whole turn's frames, even past a later unrelated wait, e.g. an approval's `extension_ui_response`) |
| `$lastMessage` | a command with a `message` or `question` string field (`prompt`, `btw`) | that field's value, so a fixture always echoes back whatever the live caller actually sent |

Lines starting with `//` are treated as comments (used here only for provenance notes) and
skipped; they are not part of the OMP wire format itself.

## Scenario selection

`REFRACT_FAKE_OMP_SCENARIO=<name>` selects `<name>.jsonl`. Unset, the engine picks `readiness`
when argv carries `--no-session` (the Rust readiness probe's own scratch, non-Session
`OmpProcess`) or `session` otherwise (a real Session's `OmpProcess`). `scripts/verify-tauri.mjs`
sets this env var per scenario it drives; see that file's own comments for which scenario backs
which proof.

## Provenance

| File | Source | Notes |
|---|---|---|
| `readiness.jsonl` | Recorded live (`get_state`/`get_available_models`/`get_login_providers` against a real, signed-in `omp`, `scripts/verify-tauri-record.mjs`'s readiness variant) | Provider/model ids replaced with placeholders (`example-provider`/`example-model-*`); field names, nesting, and the provider+id match the readiness probe (`ipc/readiness.rs`) checks for are unchanged. |
| `session.jsonl` | Recorded live (`scripts/verify-tauri-record.mjs` against a real, signed-in `omp`: negotiate, get_state, a one-tool-call turn with a `write` approval, a queued follow-up, a slash command, get_messages) | Chat text, file content, and the model/provider replaced with placeholders; every frame type, field name, and the approval dialog's `"Allow tool: <name>\nPath: ..."` title format are the real wire shapes observed. |
| `side-chat.jsonl` | Synthesized from `src/shared/frames.ts` (`BtwCommand`/`BtwDeltaFrame`/`BtwRecordFrame`/`BtwHistoryThread`) and spec 014's gate-fix notes | No live capture: the Rust build has no `btw` channel yet (`session/agent/mod.rs`'s own header). For the R6 lane (#789) once it ports one. |
| `subagents.jsonl` | Synthesized from `src/shared/frames.ts`'s `ToolExecutionUpdateFrame` (spec 004 FR-007/FR-017 to FR-020) | No live capture: a batch `task()` run needing subagents was out of the tiny-prompt budget for the one real recording. For the R5 lane (#788) once it ports subagent rendering. |
| `failure.jsonl` | Synthesized from `src/shared/frames.ts`'s `PromptResultFrame`/`PromptResultError` and contracts/omp-usage.md's "Frames Refract consumes" table | No live capture: forcing a real provider error was out of scope for the tiny-prompt budget. |
| `exit.jsonl` | Synthesized (the `__exit__` engine directive, not an OMP frame) | For the R3 lane (#786, termination/recovery as a typed state machine). |

No real chat text, file paths, account identifiers, or provider names from the recording session
are checked in anywhere in this directory; every string that came from a live model turn was
replaced with a short placeholder before being committed. The raw, unsanitised capture never left
the machine it was recorded on (a scratch temp directory, not this repository).

## Re-recording

Re-run `node scripts/verify-tauri-record.mjs --out <path>` against a real, signed-in `omp` on
`PATH` whenever the wire protocol changes (a new `omp` version, a new frame type Refract starts
depending on) and diff the result against these fixtures by field name and frame-type sequence,
never by exact chat text. Update the sanitized `.jsonl` files here by hand; never check in the raw
capture itself.
