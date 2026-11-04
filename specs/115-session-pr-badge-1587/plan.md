# Implementation Plan: Chat header badge tracks Session-written PRs and issues

**Branch**: `feat/1587-session-pr-badge` | **Date**: 2026-11-04 | **Spec**: [spec.md](./spec.md)

## Summary

A new backend module `src-tauri/src/session/github_writes/` watches completed `bash` and `eval` tool calls, tokenises their commands, and turns successful `gh` write commands into `GithubWrite` values. The Session readout keeps a per-Conversation `touched` list built from those writes, with state refreshed lazily through a new by-number GraphQL lookup that shares `readout_pr.rs`'s back-off. The renderer gains `TouchedRefControls`, mounted by `HeaderPrControls`, which draws the latest-plus-overflow layout from shared components. Persistence needs no new store: the list is rebuilt from the Conversation's own saved history, the same history OMP already persists.

## Technical Context

**Language/Version**: Rust (Tauri 2.12.3, tokio) in `src-tauri`; TypeScript + React + Tailwind in `src/renderer`.
**Primary Dependencies**: existing only (`serde_json`, `gh` through `crate::github::gh`, `@radix-ui` dropdown via `src/renderer/components/ui/dropdown-menu`). No new crate; the tokenizer is a small in-repo module.
**Storage**: none new. `touched` lives in the readout state in memory and is rebuilt from saved history (see Data and contract notes).
**Testing**: prototyping phase (AGENTS.md): no new tests; existing tests stay green. A committed `scripts/verify-*.mjs` CDP driver for the header MAY be added in the implement phase. Gate: `node scripts/ci-local.mjs`.
**Project Type**: desktop app (Tauri host + web renderer).
**Constraints**: 600-line file cap (`readout.rs` is 473 lines, so all new logic goes in new modules); comments "why" only; 2-space indent; shared components only.

## Constitution Check

Checked against `.specify/memory/constitution.md` and AGENTS.md. Principle I/II: no RPC change; the detector reads frames and history the host already receives. Principle III: Conversation state is derived from the saved Conversation, not a parallel store. Reusable components (ADR 0003): the header reuses `Badge`, `HeaderActionButton`, `DropdownMenu`. No god files: all new Rust in a new module directory, new TSX in a new file. No new tests. Clean cutover: nothing is left behind (no flag, no old path). No violations.

## Project Structure

### Documentation

```text
specs/115-session-pr-badge-1587/
  spec.md
  plan.md
  tasks.md
  analysis.md
```

### Source files to change

Backend (`src-tauri/src/session/`):

- `github_writes/mod.rs` (new): public surface, `ToolCallRecord`, `GithubWrite`, `detect`, the sink fan-out (below).
- `github_writes/shell_words.rs` (new): quote-aware tokenizer; splits a command string into simple commands at unquoted `&&`, `||`, `;`, `|`, `&` and newlines, with `'..'`, `".."` and backslash escapes. Heredocs and `$(...)` are left as opaque words so their contents never become commands.
- `github_writes/gh_commands.rs` (new): the grammar from simple command to `GithubWrite` (verbs, `-R/--repo`, URL and number arguments, `gh api` method and path rules).
- `github_writes/history.rs` (new): pairs saved `toolCall` blocks with their `toolResult` messages into `ToolCallRecord`s.
- `github_writes/touched.rs` (new): `TouchedList` (dedupe, newest first, cap 50) and its `TouchedRef` JSON.
- `readout_touched.rs` (new): readout-side glue: frame hook, stash of start-frame arguments by `toolCallId`, history rebuild, lazy state refresh.
- `readout_pr.rs`: add a by-number lookup (`item_by_number`) using GraphQL `issueOrPullRequest(number:)`, sharing `UNAVAILABLE_UNTIL` back-off and the title and URL bounds. The file is 275 lines, so it keeps the room.
- `readout.rs`: add `touched` to `State`, call `readout_touched` from `on_frame`, `on_launch`/history-load and `on_conversation_reset`, and write the `touched` key in `assemble` only when non-empty (keeps contract-replay traces unchanged).
- `agent/launch.rs`, `agent/conversations.rs`: pass the loaded history to the readout hook, as `token_guard::on_history_loaded` / `on_conversation_reset` already receive it.
- `mod.rs`: declare the new modules.

Shared and renderer:

- `src/shared/model.ts`: `TouchedRef` type and optional `SessionReadout.touched?: TouchedRef[]` (model.ts is 441 lines).
- `src/renderer/state/readout-store.ts`: `EMPTY_READOUT` unaffected (field optional).
- `src/renderer/features/chat/header/TouchedRefControls.tsx` (new): badge, +N button and menu.
- `src/renderer/features/chat/header/usePinFromMenu.ts` (new): the pin-then-keep-focus handling now inline in `LinkedIssueControls.tsx:24-26,44-50`, extracted so the two controls share it; `LinkedIssueControls.tsx` adopts it.
- `src/renderer/features/chat/header/HeaderPrControls.tsx`: compute the #1315 items, filter touched against them (FR-009), choose badge-slot or overflow-only mode (FR-008).
- `src/renderer/features/chat/header/openTouched.ts` (new): pin for a registered Project, `shell.openExternal` otherwise (FR-010).
- `docs/PLAN.md`: this story's row only. `CONTEXT.md` glossary: add "Touched item" if the implement phase introduces user-facing wording.

## Detector interface

The interface is deliberately independent of the readout so other consumers reuse it. #1589 (lists and Home counts refresh after an in-app or agent write) hangs a `github:changed` event off it without a second parser.

```rust
/// One completed tool call, from a live start/end frame pair or a saved history pair.
pub struct ToolCallRecord<'a> {
    pub tool: &'a str,          // "bash" | "eval"
    pub args: &'a Value,        // bash: { command }, eval: { code }
    pub output: &'a str,        // joined result text (the URL a create prints)
    pub is_error: bool,
    pub at_ms: i64,
}

pub enum WriteKind { Pr, Issue }
pub enum WriteAction { Create, Merge, Close, Comment, Edit, ApiWrite }

/// One detected write. `repo` is None when the command named none (the Session's repo applies).
pub struct GithubWrite {
    pub repo: Option<(String, String)>,
    pub kind: WriteKind,
    pub number: u64,
    pub action: WriteAction,
    pub at_ms: i64,
}

/// Pure: no I/O, no `gh`. Empty for errors, reads and anything unresolved.
pub fn detect(call: &ToolCallRecord) -> Vec<GithubWrite>;
/// Same, over a saved history slice (pairs toolCall with toolResult).
pub fn detect_in_history(messages: &[Value]) -> Vec<GithubWrite>;

/// Called once per live batch of detected writes; the single fan-out point.
pub(super) async fn record_writes(agent: &SessionAgent, writes: Vec<GithubWrite>);
```

`record_writes` is the only place a consumer attaches. Today it updates the touched list and schedules a readout update. #1589 adds one line there that emits a `github:changed { repo, kind, number, action }` event (a new constant in `src-tauri/src/events.rs` plus the usual IPC and bridge entries), and in-app merge and close handlers call the same event from their own side. Nothing in this story emits it.

## Data and contract notes

Wire shape, `SessionReadout.touched?` (omitted when empty):

```ts
interface TouchedRef {
  ownerRepo: string            // "owner/repo"
  repositoryId: string | null  // registered Project that owns it, resolved in Rust
  kind: 'pr' | 'issue'
  number: number
  title: string                // bounded 200 chars, plain text
  url: string                  // https only, bounded 2048
  state: 'open' | 'closed' | 'merged' | 'draft' | 'unknown'
  lastTouchedAt: number        // ms
}
```

- **Detection from tokens**: tokenise, then for each simple command skip leading `NAME=value` words and `cd ... &&` prefixes; require word 0 to be `gh`; match `pr|issue` plus a verb; `gh api` is a write only with `-X/--method` POST, PATCH, PUT or DELETE or `--input`, on a path matching `repos/{o}/{r}/(pulls|issues)/{n}` (comment sub-paths included). Flags that take a value are skipped by a per-verb table so `--body "..."` never yields a number.
- **Number**: first of: positional number or URL argument; the first `https://github.com/{o}/{r}/(pull|issues)/{n}` URL in the output (creates, and merge/close output that echoes it). Unresolved: no item.
- **eval**: each string literal in `code` whose trimmed text starts with `gh ` is tokenised as a command line. Array-form calls are not detected.
- **Live pairing**: the end frame carries the result, the start frame carries the arguments; `readout_touched` stashes bash and eval arguments by `toolCallId` at `tool_execution_start` (bounded to 64 entries) and builds the `ToolCallRecord` at `tool_execution_end`. [INFERENCE: the end frame has no `args`; checked only against `transcript.rs`, which reads `args` from the start frame.]
- **Persistence**: `history.rs` pairs assistant `toolCall` blocks (`id`, `name`, `arguments`) with `toolResult` messages (`toolCallId`, `isError`, `content`) as `transcript.rs` reads them. Rebuilt on launch and on `open_conversation`; cleared on New conversation by the existing reset hook. This is what "persisted with the Conversation" means here and avoids a second store that could disagree with the Conversation file.
- **State refresh**: on each readout recompute, items with state `unknown` or last refreshed before this recompute are fetched at most once through `readout_pr::item_by_number`, spawned like the branch PR lookup so `gh` never blocks the run. A backed-off or failed fetch keeps the previous state.
- **Project match**: Rust compares each item's `owner/repo` with registered repositories (`owner_repo_for`, cached) and sets `repositoryId`.
- **Renderer**: `HeaderPrControls` builds the #1315 list as today, removes touched items that match the branch PR, origin issue or closing issues, then renders `TouchedRefControls` in `badge` mode (no #1315 controls) or `overflow` mode (only the +N button and menu, after the #1315 controls). Menu rows show kind icon, `ownerRepo#N` for a foreign repo, title and a state word. The +N button: label `"${n} more pull requests and issues"`.

## Risks

- **Parsing gaps**: unusual shell forms (variables for numbers, `xargs`, here-strings) are missed and the item simply does not appear; the detector never guesses. Accepted.
- **Frame shape**: if the end frame does carry `args`, the stash is unnecessary but harmless; verified during implement against a real frame sample.
- **Readout churn**: the readout is recomputed on every tool event; the refresh rule (once per item per recompute, with back-off) keeps `gh` calls bounded. Implement checks that a burst of 20 writes does not issue 20 lookups per recompute.
- **Fixtures**: `touched` is omitted when empty so contract-replay traces stay byte-compatible.
- **History size**: rebuilding scans the full history once per attach; it only inspects `bash` and `eval` tool calls.

## Complexity Tracking

None. The one added moving part (the tokenizer) is required by the grill ("parse with a tokenizer, not a regex") and no existing tokenizer was found in the repo.
