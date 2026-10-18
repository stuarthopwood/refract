# Research: #941 Subagent chain / Stage rows / Subagents panel polish

Read-only research for issue #941 (green for finished, named Stages with details, real `agent://`
dependencies, Up next from OMP `todoPhases`). No code changed. `CONTEXT.md`/`docs/PLAN.md`/
`docs/design/foundations-icons.md` already carry the #941 vocabulary (Stage name, Todo phase, Up
next, the green-finished colour rule) from PR #942 — quoted below as ground truth, not re-derived.

---

## 1. Rust side (`src-tauri/src/omp/`)

**Transcript `subagent` item construction**: `src-tauri/src/omp/transcript.rs:101-125` defines the
`TranscriptItem::Subagent` enum variant (serde `camelCase`):

```rust
Subagent {
    id: String,
    tool_call_id: String,
    spec_index: u32,
    name: String,
    task: String,
    status: SubagentStatus,         // #[serde(default, skip_serializing_if...)] started_at: Option<i64>,
    duration_ms: Option<i64>,
    result: Option<String>,
    job_id: Option<String>,
    message_id: ...                  // owning assistant message id
}
```

(`SubagentStatus` enum at `transcript.rs:187-191`: `Running | Done | Error` — serialized
lowercase; `cancelled`/`exited` are applied elsewhere, see below.)

The actual population logic lives in the split module
`src-tauri/src/omp/transcript/subagent_items.rs` (port of `src/main/omp/transcript.ts` lines
110-278, per its header comment — **the old TS file no longer exists in this worktree**
(`src/main/omp/transcript.ts` is gone; only this Rust port remains, so there is no TS original left
to cross-check against)):

- `read_task_specs(args)` (:21-26) reads `args.get("tasks")` only — a plain array of objects.
- `task_text(spec)` (:28-33) reads `spec.get("task")` (a string).
- `subagent_name(spec)` (:35-50) reads `spec.get("name")`, else truncates `task_text`.
- `upsert_subagent_items` (:58-94) builds one `TranscriptItem::Subagent` per `specs[]` entry from
  **only** `name` and `task`; `message_id` is stamped `String::new()` here and filled in later by
  `build_assistant_items`'s own task branch once the echoed assistant message snapshot arrives.
- `map_progress_status`/`apply_batch_task_result`/`apply_async_result_jobs`/`jobs_from_details`
  (:96-301) apply a `task()` call's own `tool_execution_end`/`toolResult`/async-result
  (`details.progress[]`/`details.jobs[]`) onto the matching items by index/id/label, never reading
  anything beyond `status`, `id`/`index`, `durationMs,` and the result text.

**No field named `context` is read anywhere in this file, `transcript.rs`, or
`session/subagents.rs`.** `args.get("tasks")` is the only key ever pulled off a `task` call's
`args` object; a would-be top-level `args.context` (the batch brief CONTEXT.md's **Stage** entry
says names the Stage — "Stage 1 · Quality gate for #923") is never read, stored, or serialized
anywhere in the Rust transcript pipeline today.

**Confirming the batch `context` argument is available on the wire at all**: it is **not
confirmed**. Searched:
- `scripts/fixtures/omp-schema/rpc-wire.schema.json` (the vendored OMP RPC wire schema): no
  `context` field on any task/subagent-shaped def. The closest shapes are `SubagentSnapshot`
  (:3199-3250, for `get_subagents`: `id, index, agent, agentSource, status, lastUpdate,
  description, task, assignment, sessionFile, progress, parentToolCallId`) and the todo tool's
  `TodoItem`/`tasks` (:2293-2303, unrelated — that is the **todo** tool, not **task**/subagent
  spawning). No schema entry documents the raw `tool_execution_start` args shape for the `task`
  tool itself (tool-call args are tool-specific and not part of this generic RPC envelope schema).
- `docs/spike/FINDINGS.md` item 22(e) (the authoritative live-probe note this Rust port cites):
  describes `details.progress[]`/`details.jobs[]` shapes only, no `context` argument.
  `docs/PLAN.md:185` (`rpc.md`, the probe-reference doc for a different story, Ask notes) is
  referenced elsewhere in PLAN.md but is **not present in this worktree's `docs/`** (only
  `docs/spike/FINDINGS.md` and `docs/design/*` exist; no top-level `rpc.md` file was found by
  glob).
- `scripts/fixtures/omp-frames/subagents.jsonl` and `subagents-background-turn.jsonl` (both
  explicitly "SYNTHESIZED, not captured live") show `args:{"tasks":[{"name":...,"task":...}]}`
  with **no top-level `context` key** — but these are synthetic fixtures built from the documented
  contract, not a live capture, so their absence of `context` is not proof OMP never sends one.

  **Gap**: #941's own PLAN.md row ("each Stage **named** from its batch context's first line")
  presupposes a `context` argument on the real `task()` tool call that is not yet verified against
  a real OMP install anywhere in this repo's probes. A live probe (same pattern as
  `docs/spike/get-subagents-probe.mjs`/`todo-progress-probe.mjs`) is needed before wiring a new
  Rust field for it — if the real wire has no such field, the PLAN row's own documented fallbacks
  ("the agents' shared prefix, then 'Stage N'") become the only available source.

**`get_state().todoPhases` wiring** — confirmed already read, but only as an aggregate count, not
named phases:
- `src-tauri/src/session/readout.rs:105` — `State.todo_phases: Option<Vec<TodoPhaseState>>`.
- `src-tauri/src/session/readout.rs:84-86` — `TodoPhaseState { tasks: Vec<TodoTaskState> }` (no
  `name` field captured — the phase's own name is dropped at parse time).
- `src-tauri/src/session/readout.rs:266` — `on_sync_from_state`: `state.get("todoPhases")` parsed
  by `parse_todo_phases` (`:327-...`), called once per `get_state` sync.
- `src-tauri/src/session/readout.rs:572-583` — `build_readout_value`'s `todo_progress`: reduces
  every phase's tasks to a bare `{done, total}` count (`status == "completed"` count over the
  flattened task list across ALL phases) — **the phase name and per-phase task breakdown are
  computed internally then thrown away**; only the aggregate crosses into the `"todoProgress"` key
  of the readout JSON (:597).

  **Gap**: `TodoPhaseState` needs a `name: String` field (currently absent, :84-86) and
  `build_readout_value` needs to serialize the phase list itself (name + its tasks' `content`/
  `status`), not just the aggregate, for **Up next** (CONTEXT.md: "the muted list of the agent's
  pending Todo phases shown after a turn's Stages... Live state only").

---

## 2. Shared TS types (`src/shared/model.ts`, `frames.ts`)

**Current subagent transcript-item type** — `src/shared/model.ts:440-464`:

```ts
| {
    kind: 'subagent';
    id: string;
    toolCallId: string;      // the parent `task` call's id
    specIndex: number;
    name: string;            // the task's own `name`, else its `task` text truncated
    task: string;            // the full prompt text (tasks[i].task)
    status: 'running' | 'done' | 'error' | 'cancelled' | 'exited';
    startedAt?: number;
    durationMs?: number;
    result?: string;
    jobId?: string;
    messageId: string;       // owning assistant message's id; groupSubagentStages keys on this
  }
```

No `context`/`dependsOn`/`uses` field exists. `messageId` is the Stage-membership key (see §3).

**`SubagentSummary`** (the live `/state/readout-store.ts` row backing the Subagents panel and
`ChainAgentEntry`'s correlation lookup) — `src/shared/model.ts:347-389`:

```ts
export interface SubagentSummary {
  id: string;
  toolCallId: string;
  specIndex: number;
  nameOrTask: string;
  status: 'running' | 'finished' | 'failed' | 'cancelled' | 'exited';
  startedAt: number;
  durationMs?: number;
}
```

No `parentId`/dependency field here either (its own doc comment at `SubagentPanel.tsx:30-34`
explicitly says "no `parentId` exists on `SubagentSummary` today" — see §4 gap).

**`SessionReadout`** — `src/shared/model.ts:336-337`:

```ts
subagentCount: { running; finished; exited; failed; cancelled } | null;
todoProgress: { done: number; total: number } | null;
branch?: { name; detached } | null;
```

No per-phase `todoPhases` type exists on the wire-facing readout shape — only the aggregate
`{done, total}` (matches the Rust gap in §1).

**The raw OMP `get_state` passthrough type** — `src/shared/frames.ts:164`:

```ts
todoPhases?: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>;
```

This is the one place the **named**-phase shape is typed at all in TS — but it types the raw
OMP-side `GetStateResult`-like frame payload consumed by the (now-Rust-only) main process, not
anything the renderer receives. `model.ts:517` cross-references it only in a doc comment ("the
`todo` tool's own state stays available for a later readout (e.g. `get_state().todoPhases`)").

**Todo readout chip** (§5 detail) reads `todoProgress` (the aggregate), not `todoPhases` — grep for
`todoPhases` across `src/renderer` returns **zero hits**; the chip and its store never see names.

---

## 3. Renderer grouping — `groupSubagentStages.ts`

Full file read (93 lines). Algorithm:

- `StageGroup` (:7-19): `{ kind: 'stage-group'; id: string; items: SubagentItem[]; stageIndex:
  number; totalStages: number }`. No `name` field.
- `groupSubagentStages(items)` (:53-93): single pass, maintains a `run: SubagentItem[]` and
  `runMessageId: string | null`. For each `subagent`-kind item: if the run is non-empty and the
  item's `messageId` differs from `runMessageId`, flush the current run into a new `StageGroup`
  first. Any non-subagent item flushes the run (**except** a `notice` whose `id` starts with
  `HIDDEN_TOOL_NOTICE_PREFIX` — the one documented exception, mirroring `groupToolItems`). After
  the full pass, every stage gets `stageIndex`/`totalStages` stamped in start order.
- Grouping key is **exclusively** `item.messageId` (stamped by the Rust builder, §1) — never
  position/adjacency/timing, per the file's own header comment (reopened history carries no
  subagent timing).

**Gap**: `StageGroup` carries no `name`/batch-context field at all — #941 needs a Stage `name`
(first line of the batch context, with documented fallbacks) threaded in here, sourced from
whatever the Rust/TS pipeline ends up carrying per #1's gap, most likely as a new field on the
first `SubagentItem` of the run (parallel to `messageId`) since `StageGroup` itself is a pure
renderer-built aggregate with no independent transcript-item identity of its own.

---

## 4. Renderer rendering

### `SubagentChainRow.tsx` (431 lines, full file read)

- `StageGroupRow({ group })` (:123-238) — one Stage in place. `solo = items.length === 1` renders
  identically to a bare `SubagentRow` via `CollapsedLine` (decision 1/gate addendum B — the Stage
  number lives ONLY in `triggerAriaLabel`, never the visible label, for a solo Stage). A
  multi-member Stage renders `label={`Stage ${group.stageIndex}`}` (:206) — **today's visible
  label is literally the bare string "Stage N", with no name text at all** — plus a roll-up
  `summaryText` (`stageRunningSummary`/`stageSettleSummary`, :59-107) and a `SpineList` of member
  `SubagentRow`s.
- `ChainAgentEntry({ item, sessionId })` (:246-278) — the one existing "turn an agent reference
  into a clickable control" pattern in the codebase (see §8): looks up the live `SubagentSummary`
  by `toolCallId`+`specIndex` match (never by `item.id`, since the two id schemes are unrelated,
  per `model.ts`'s own documented rule) from `useReadoutStore(...).subagents`; if found, renders a
  `<button>` that calls `openHostedPanel('subagents', sessionId, { selectSubagentId: match.id,
  opener: event.currentTarget })`; if not found (tracker lost it) or no `sessionId`, renders plain
  unstyled text (decision 7: "unbuilt actions are hidden, not disabled").
- `ChainStageLine({ stage, sessionId })` (:285-306) — one Stage's line in the chain body:
  `<span className="shrink-0 font-medium">Stage {stage.stageIndex}</span>` (:298) then a row of
  `ChainAgentEntry`s. Same "bare Stage N" label, no name.
- `SubagentChainRow({ stages, sessionId })` (:342-431) — the per-turn summary, shown only for 2+
  Stages; label is the fixed literal `"Subagents"` (:405), summary is `"${stages.length} stages,
  ${allItems.length} agents, <rollup>"` (:386).
- Status colouring today: every status icon comes from `SubagentStatusGlyph`/`SubagentStatusIcon`
  (`subagentStatus.tsx`, §4 next) — `finished` renders `STATUS_GLYPH['neutral-done']` =
  `CheckCircle2Icon` with class `text-state-idle` (a neutral grey token, not green) — confirmed
  gap matching #941's "green for finished" ask.
- Stage "details" (agent/status counts, duration, start time; brief+result on expansion) already
  exist for the roll-up text and duration (`stageTimeRange`, `stageSettleSummary`,
  `stageRunningSummary`) and expansion (`SubagentBody`, `ToolRow.tsx:487-...`, shows `item.task`/
  `item.result`) — the counts/duration/roll-up machinery is already built; only the per-Stage
  **name** and the **start time** display (today only duration is shown, not a wall-clock start
  time) are new asks.

### `SubagentPanel.tsx` (299 lines, full file read)

- `SubagentTreeNode` (:22-28): `{ id, nameOrTask, status, durationMs, children: [] }`. `children`
  is unconditionally empty — `buildSubagentTree` (:35-42) maps the flat `SubagentSummary[]` 1:1
  with no parent/child relationship at all; its own doc comment (:30-34) says this is because "no
  `parentId` exists on `SubagentSummary` today" and nothing here needs to change once it does,
  "only this one function."
- Tree row rendering (:252-264): `SubagentStatusIcon` (icon+word) + `nameOrTask` (truncated) +
  duration if settled. Same neutral `finished` colouring as the chat rows (shared table, see next
  section) — same green gap applies here too (CONTEXT.md's **Status icon** entry explicitly
  includes the Subagent panel in the "amended" rule).
- Keyboard nav (ArrowRight/ArrowLeft, :153-172) already anticipates a real child level ("Moves to
  the first child the instant one exists") — built, but inert until `children` is ever non-empty.

  **Gap for "real `agent://` dependencies"**: the panel's tree has no parent/child wiring at all
  today (flat list only); `rpc-wire.schema.json`'s `SubagentSnapshot.parentToolCallId` (§1) is the
  one piece of real OMP wire data that could supply it, but nothing in `src-tauri` reads
  `get_subagents`/`parentToolCallId` today (`session/subagents.rs`'s own header comment explicitly
  disclaims calling `get_subagents` at all — see its block comment, "a fresh process's own
  registry is always empty, even onto the SAME Conversation" — so a reattach case aside, the
  per-call-frame `tool_call_id`/`spec_index` plumbing is the only identity path, and it does not
  carry a "started by whom" relationship). An `agent://<id>` string embedded in Stage/result text
  (the "Uses:" feature) is a separate, text-based reference, not the same thing as this tree's
  `parentId` hierarchy — see §8 for the one existing "turn a reference into a button" pattern to
  reuse.

### `statusGlyph.ts` (25 lines, full file read) and `subagentStatus.tsx` (87 lines, full file read)

```ts
export type StatusGlyphKey = 'running' | 'neutral-done' | 'error' | 'neutral-muted' | 'cancelled'
export const STATUS_GLYPH: Record<StatusGlyphKey, { Icon; className }> = {
  running:       { Icon: LoaderCircleIcon, className: 'animate-spin text-state-working' },
  'neutral-done':{ Icon: CheckCircle2Icon, className: 'text-state-idle' },   // <- today's "finished"
  error:         { Icon: XCircleIcon,      className: 'text-severity-error' },
  'neutral-muted':{ Icon: UnplugIcon,      className: 'text-muted-foreground' },
  cancelled:     { Icon: CircleStopIcon,   className: 'text-muted-foreground' },
}
```

Consumers: `toolStatus.tsx`'s `StatusIcon` (tool rows/groups — **must stay neutral per #941's own
PLAN row**: "tool rows stay neutral, amending #570/#563") and `subagentStatus.tsx`'s
`SubagentStatusGlyphIcons` (:35-38), which every Stage/chain/panel surface goes through via
`GLYPH_KEY_BY_STATUS` (:24-30, maps `SubagentRowStatus.finished -> 'neutral-done'`).
`subagentStatus.tsx` also holds `SUBAGENT_STATUS_LABEL` (:12-18, `finished: 'Finished'`, word is
`sr-only` for `finished` specifically — a finished reviewer subagent may still have a FAIL
verdict, :40-43 doc comment), `chatRowStatus` (:75-79, maps the chat item's
`running|done|error|cancelled|exited` onto the shared `SubagentRowStatus` vocabulary), and
`summarizeSubagentStatuses` (:83-87, the roll-up counter both Stage/chain rows share).

`docs/design/foundations-icons.md:62` ("Chat Status icons") is the one doc location describing
this shared table today — **not yet amended** with the #941 green-for-finished rule (that
amendment is tracked as a to-do in `docs/PLAN.md:376`'s Decisions bullet, "written into
`docs/design/foundations-icons.md` ('Chat Status icons')" — i.e. the decision is recorded in
PLAN.md but the actual edit to `foundations-icons.md` itself has **not yet landed** — confirmed:
`foundations-icons.md:62` still reads "a check-circle for done/finished" with no colour qualifier,
and the file's own `grep` for "green" returns nothing).

**Gap, precisely scoped**: a new glyph key (e.g. `'success-done'`) is needed, used ONLY by
`subagentStatus.tsx`'s `GLYPH_KEY_BY_STATUS['finished']` — `toolStatus.tsx`'s `StatusIcon` must
keep mapping its own `done`/equivalent status to `'neutral-done'` unchanged (PLAN.md: "tool rows
stay neutral"). `SubagentStatusIcon`'s own visible-word behaviour (`sr-only` for finished, :48-54)
is a SEPARATE concern from the icon colour and is untouched by this — but #941 also asks for
**green text**, not just a green icon, which the current `SubagentStatusIcon`/`SubagentStatusGlyph`
components do not parametrize at all (the word span's own class is hardcoded
`'shrink-0 whitespace-nowrap'`, :52, no colour token) — so the text-colour half of "green check and
green text" needs a second change beyond the icon's own `className`.

---

## 5. Todo readout chip

- Component: `src/renderer/features/chat/readout/ReadoutChips.tsx:245-257`, `TodoProgressChip`:
  reads `useReadoutStore((s) => ...readout.todoProgress)`, renders `ReadoutChip` with `ListTodoIcon`
  and text `Todo {done}/{total}` (plus an identical `sr-only` span). Hidden entirely when
  `todoProgress === null` (FR-021: "hidden when the agent has no task list at all").
- Mounted from `ComposerStatusLine.tsx:36`: `{sessionReadout['todo-progress'] && <TodoProgressChip
  sessionId={sessionId} />}`.
- Store type: `src/renderer/state/readout-store.ts:21-22` seeds `todoProgress: null` in
  `EMPTY_READOUT_ENTRY`; the live value flows in verbatim from the Rust `readout:update` IPC
  payload's `"todoProgress": {done, total} | null` key (§1/§2 — the SAME aggregate, no names).

**This is the "already read for the Todo readout chip" FINDINGS-item-35 reference** — confirmed:
it reads only `{done, total}`, never phase names or per-phase task lists. **Up next (#941) needs
a genuinely new field** (phase name + pending task count/text per phase), not a reuse of
`todoProgress` — the aggregate chip and the new Up-next list are two different consumers of the
same underlying OMP `todoPhases` data, requiring the Rust/TS/readout-store plumbing gap from §1/§2
to be filled before Up next can render anything.

---

## 6. ADR 0003 and shared primitives in `src/renderer/components/`

`docs/adr/0003-reusable-ui-components-only.md` (full file read, 7 lines): "All UI elements should
be re-usable components, enhanced when use cases add complexity." Every control comes from a
shared component in `src/renderer/components/`; a new use case extends via prop/slot, never
copies/restyles in a feature folder; reviewers block new one-offs. `docs/design/components.md:5-7`
restates the same rule verbatim (not reproduced again here).

`src/renderer/components/` top level (12 entries): `SearchField.tsx`, `ReasoningGaugeIcon.tsx`,
`ui/` (Radix-wrapped primitives: `collapsible.tsx`, `tooltip.tsx`, `resizable.tsx`, `scroll-area.tsx`,
`button.tsx`, etc.), `brand/AgentSpinner.tsx`. **No existing "Stage summary" or "collapsible group
row" primitive lives here yet** — the actual expand/collapse building blocks #941 would build a new
shared "Stage summary" component FROM are feature-folder-local, not yet promoted to
`components/`:

- `src/renderer/features/chat/CollapsedLine.tsx` (247 lines; props read in full, :1-73) — wraps
  `components/ui/collapsible.tsx`'s `Collapsible`/`CollapsibleContent`/`CollapsibleTrigger` with
  the shared icon/label/summary/meta/action/detail slot layout every group row (Tool group, Thought
  run, Stage, Subagent chain) already uses. Exports `LABEL_COLUMN_CONTENT_CLASS = 'pl-8'`.
- `src/renderer/features/chat/SpineList.tsx` (56 lines, :1-43 read) — the shared 1px connector
  (`<ol>`, `border-l border-divider`, `gap: 'member' | 'stage'`), used by `ToolGroupRow`,
  `StageGroupRow`, `SubagentChainRow`'s own stage-list, and Thought runs.

**Gap**: both `CollapsedLine` and `SpineList` live under `features/chat/`, not
`components/`, i.e. they are already the de-facto shared primitive for exactly this "collapsible
group row with a connector" pattern ADR 0003 asks for — but neither has been promoted into
`src/renderer/components/` as a formal cross-feature primitive. #941's own ask ("Stage/chain-line/
panel-node must share one component") is best served by building the new "Stage summary" piece on
top of these two existing ones (as `StageGroupRow` already does), rather than inventing a third
building block — whether that new shared piece itself belongs in `components/` per ADR 0003's
letter, or stays feature-local like its own two dependencies currently do, is a design decision for
implementation, not settled by anything already in the repo.

---

## 7. Golden/contract-replay trace pattern (`advisorOn`)

`grep -r advisorOn` across the **entire worktree** (code, docs, fixtures, scripts, `git log --all
--oneline`) returns **zero matches**. There is no `advisorOn` identifier, commit, fixture, or test
anywhere in this checkout — `#972` and its `advisorOn` golden-trace pattern referenced in the
assignment **do not exist in this worktree's history or files**. (`git log --all --oneline | grep
-i advisorOn` was attempted via the same search path and also found nothing; the worktree's own
`git log` is scoped to `feat/941-stages` off `origin/main` at `142368a`, so `#972` may be a PR on a
branch not fetched/visible from this worktree, or the reference may not resolve to this repo at
all.)

**What exists instead, as the closest available "golden trace replayed against both Rust and TS
expectations" pattern**: `scripts/fixtures/omp-frames/*.jsonl` (plain-text frame tapes, §9) plus
their own `README.md`'s documented "provenance table" (each fixture marked live-captured vs.
synthesized) are the repo's actual golden-trace mechanism — replayed by the fake-omp shim
(`scripts/verify-tauri-fake-omp.mjs`, §9) through a real Tauri build via CDP, not through a unit
test replay harness. No Rust-side `#[test]` fixture-replay harness consuming these `.jsonl` files
was located (`subagents.rs`/`subagent_items.rs` carry no `#[cfg(test)]` modules of their own in the
files read; `transcript.rs`'s own inline construction logic is exercised by whatever `cargo test`
suite exists elsewhere in the crate, not inspected further here as it was outside this grep's
hits). **This area's deliverable could not be completed as specified** — the referenced #972/
`advisorOn` pattern is not reachable from this worktree by any tool available (grep, glob, git log
--all), so no file:line triplet diff can be shown. A new Stage/`todoPhases` field would instead
follow the pattern actually present here: extend a `.jsonl` fixture (e.g. `subagents.jsonl`'s
`tool_execution_start` args, or `get_state`'s response) with the new key(s), matching the Rust
parser's new field and the TS type's new field — i.e. the same three-sided (fixture / Rust / TS)
consistency §1/§2's "Rust fields to add" / "TS fields to add" lists already aim for, just without
an `advisorOn` precedent to copy mechanically.

---

## 8. Existing `agent://` link rendering (prior art for "Uses:")

No existing renderer code turns a literal `agent://<id>` **string** into a clickable control —
grep for `agent://` across `src/renderer` only matches **code-review-comment identifiers**
(`agent://Arch877`, `agent://G909Code`, etc. — internal reviewer-session tags embedded in source
comments, unrelated to OMP subagents or any runtime string).

`src/renderer/features/chat/Markdown.tsx`'s link renderer is deliberately **http(s)-only** by
design (`:749-757`'s own security-review comment: "`file:`/`mailto:`/`javascript:`/`data:`/unknown
schemes can reach main's `shell.openExternal` in unintended ways" — `markdownUrlTransform` reduces
every href to either a safe http(s) URL, an unchanged footnote fragment, or `''`/blocked). An
`agent://` scheme would never survive that transform as a markdown `<a>`.

**The one actual precedent for "turn an agent reference into an activatable control"** is
`ChainAgentEntry` (`SubagentChainRow.tsx:246-278`, §4): not a markdown link at all, but a plain
`<button>` that correlates a reference (there, `toolCallId`+`specIndex`) against the live
`SubagentSummary[]` list and calls `openHostedPanel('subagents', sessionId, { selectSubagentId,
opener })` — falling back to inert plain text when the tracker no longer knows the target (decision
7: "unbuilt actions are hidden, not disabled"). For "Uses:" (#941), the natural reuse is this same
button pattern: parse an `agent://<id>` reference out of wherever it appears (Stage brief/result
text), resolve `<id>` against the live subagent list the same way, and render the SAME
button-or-plain-text shape — not a Markdown-link change, since Markdown's http(s)-only rule is a
deliberate security boundary that should not be loosened for this.

---

## 9. Live-check script conventions

### `scripts/verify-947-938-slash-menu.mjs` (477 lines, full file read)

Pattern (drives a **real ambient `omp`**, not the fake-omp shim — see `verify-tauri-fake-omp.mjs`
below for that alternative):

1. **Scratch setup** (:62-78): `mkdtempSync` for `dataDir`/`importSourceDir`/`exeDir`/
   `launcherDir`; `makeScratchRepo` (from `verify-tauri-scratch-helpers.mjs`) for a throwaway git
   repo; `mkdirSync(SHOTS_DIR, {recursive:true})`; a `settings.json` seeded with
   `{version:1, approvalMode:'auto'}`.
2. **Build + launch** (:80-104): `getFreePort()`, `gitHead(REPO_ROOT)` + `git status --porcelain`
   for the `dirty` flag, `buildAndCopyExeFresh(exeDir, BUILD_OUTPUT_DIR, REPO_ROOT, {label})`,
   `buildLauncher(launcherDir)`, `launchBuiltExe(launcherExe, exePath, {port, dataDir,
   importSourceDir, logFile})`, `waitForCdpTarget(port)`, `CdpSession.connect(wsUrl)`,
   `isTargetOwningPort(port, targetPid)` (ownership assertion before driving anything).
3. **App-level readiness/session setup** (:106-133): waits for `[data-readiness-primary]`,
   clicks it, adds the scratch repo via the Add-repository dialog, creates a session, waits for the
   composer to enable — i.e. drives the REAL app through a real signed-in `omp` attach.
4. **Scenario-specific steps** (:135-438): each section pushes onto three parallel arrays —
   `findings` (confirmed facts), `failures` (hard fails, always fail the run), `notExercised`
   (genuine skips, e.g. a tier this install's command list doesn't support) — screenshots via
   `cdp.screenshot(path.join(SHOTS_DIR, 'NN-description.png'))` at each milestone.
5. **`report.json`** (:439-440, and the `catch` block's own :452-460 mirror): `{gitHead, dirty,
   exeSha256, findings, failures, notExercised, exitCode}` (plus `error` in the catch path),
   written unconditionally (even on a thrown error) so a crashed run still leaves evidence.
6. **Teardown** (`finally`, :463-471): `cdp.close()`, `stopLauncher(child)`, `safeRmSync` on every
   scratch dir.

### `scripts/verify-tauri-fake-omp.mjs` (235 lines, header + structure read)

The **isolated, no-real-model** alternative pattern: a native shim built by
`verify-tauri.mjs`'s `buildOmpShim` is placed first on `PATH` as `omp.exe`, execs `node
verify-tauri-fake-omp.mjs <args>` inheriting the real app's stdio. It replays a `.jsonl` tape from
`scripts/fixtures/omp-frames/` chosen by `REFRACT_FAKE_OMP_SCENARIO` (default `session`; `subagents`
and `subagents-background-turn` fixtures already exist and are documented as not yet driven by any
lane — "fixtures for a future lane to drive directly once it ports the matching channel", i.e. a
Stage-naming live-check targeting Stage/`todoPhases` could extend one of these two existing
fixtures rather than building a new one from scratch). Tape format: plain JSONL frames,
`{"__wait__":[...types]}` to pause for a command, `{"__delay__":ms}`, `{"__exit__":{"code":n}}`,
`{"__stderr__":"text"}`; sentinels `$lastId`/`$turnId`/`$lastMessage`/`$conversationFile` get
substituted per-line (`substitute`, :73-92).

### `scripts/verify-tauri-cdp.mjs` — every exported helper, exact signature

```ts
export async function getFreePort()
export async function waitForCdpTarget(port, { timeoutMs = 60_000, intervalMs = 300 } = {})
export class CdpSession {
  constructor(ws, { requestTimeoutMs = 20_000 } = {})
  static async connect(wsUrl, { timeoutMs = 20_000 } = {})
  send(method, params = {})
  close()
  async evaluate(expression)
  async waitFor(expression, { timeoutMs = 30_000, intervalMs = 250, label = expression } = {})
  async click(finderExpr, { timeoutMs = 15_000 } = {})
  clickByLabel(label, { inDialog = false, prefix = false } = {})
  clickByText(text, { inDialog = false, tag = 'button' } = {})
  async typeIntoByLabel(label, text, { inDialog = false } = {})
  async pressEnter()
  async screenshot(outPath)
}
export async function launchViaJobObject(launcherExe, pidFile, targetExe, targetArgs, { cwd, env } = {})
export async function stopLauncher(child, { graceMs = 5000 } = {})
export function isTargetOwningPort(port, targetPid)
export function getProcessExecutablePath(pid)
export function assertExeMatchesProcess(pid, expectedExePath, expectedHash)
export function createReportLogger(filePath)
export async function resolveCssVarColor(cdp, varName, property = 'outline-color')
export { sleep }  // function sleep(ms)
```

### `scripts/verify-tauri-scratch-helpers.mjs` — every exported helper, exact signature

```ts
export function gitHead(repoRoot)
export function buildLauncher(dir)
export function makeScratchRepo(dir, label)
export function sha256OfFile(filePath)
export function citeScreenshots(dir, names)
export function clearKnownOutputFiles(shotDir, prefix, fileNames)
export function buildAndCopyExeFresh(destDir, buildOutputDir, repoRoot, { maxAttempts = 3, label = 'verify' } = {})
export async function launchBuiltExe(launcherExe, exePath, { port, dataDir, importSourceDir, logFile })
export async function safeRmSync(dir, label = 'verify')
export function assertExeUnchanged(exePath, expectedHash, label, scriptLabel = 'verify')
export async function getAccessibleNameAndRole(cdp, selectorExpr)
export async function switchTheme(cdp, themeId, themeName)
export function requireSharedCargoTarget(repoRoot)
```

---

## Rust fields to add (proposed serde names, camelCase on the wire)

- `TranscriptItem::Subagent.context: Option<String>` — the batch call's own raw context string
  (first line becomes the Stage name per PLAN.md's rule), **pending a live probe confirming the
  real `task()` tool call's `args` actually carries a `context` key** (§1 gap — not assumed).
- `session::readout::TodoPhaseState.name: String` (currently absent, `readout.rs:84-86`) — the
  phase's own name, parsed alongside its existing `tasks`.
- `build_readout_value`'s readout JSON gains a `todoPhases: Vec<{name, tasks: Vec<{content,
  status}>}>` key (or a reduced `pendingPhases` list of names+counts) distinct from the existing
  `todoProgress` aggregate, for **Up next**.
- (Only if a real dependency/parent signal is ever wired from `get_subagents`, out of scope unless
  #941 commits to it): a `parent_tool_call_id: Option<String>` mirroring the schema's
  `SubagentSnapshot.parentToolCallId`, matching `SubagentSummary`'s own naming style.

## TS fields to add (proposed, matching the Rust serde names above)

- `TranscriptItem` (`kind: 'subagent'`): `context?: string`.
- `StageGroup` (`groupSubagentStages.ts`): `name?: string` (derived from the run's own `context`/
  fallback chain, computed where the Stage is assembled, not a 1:1 wire field).
- `SessionReadout`: `todoPhases?: Array<{ name: string; done: number; total: number }>` (or the
  fuller `{name, tasks:[{content,status}]}` shape if Up next needs per-task text, not just counts —
  the minimum CONTEXT.md's own definition needs is "the muted list of the agent's pending Todo
  phases", i.e. names are required, full task text is not specified as required).
- `SubagentSummary`/tree node (only if the parent-link gap above is tackled): `parentId?: string`
  (matches the doc comment's own already-chosen name at `SubagentPanel.tsx:32`).
