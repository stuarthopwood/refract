# Tasks: Side chat (`/btw`)

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Prerequisites**: spec 013 (right pane shell, panel-registry.ts, RightPaneShell.tsx) merged on
`main` (#665). `.specify/memory/constitution.md` and
`specs/001-core-session-workspace/contracts/omp-usage.md` already amended in this spec's own
docs-only PR (Slice 0, below) before any implementation task starts. Windows 11 only; OMP 18.6.3
or later required to exercise anything past Slice 1.

**Tests**: none. Refract is a prototype (constitution, Development Workflow). Each phase ends with
a **Checkpoint** that runs the matching [quickstart.md](quickstart.md) section by hand, on the
built app. `pnpm typecheck` and `pnpm build` MUST pass before a change lands on `main`; run
`pnpm check:ui-text`, `pnpm check:theme-contrast`, and `pnpm check:drag-regions` (if present on
the base branch) once per full gate, not per task.

**Organization**: three slices, same reasoning spec 013 used -- shell/hosting first (a visible but
inert panel), RPC wiring second (the feature's actual behaviour), UI polish last (composer
interception, per-answer actions). Task IDs (`T001` onward) are local to this spec.

**GitHub issues**: issue://1 and issue://516 already exist and cover this spec's whole scope; no
additional per-task issues filed.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: the user story from [spec.md](spec.md) (US1 to US5). Setup, Foundational, and
  Polish tasks carry no story label.
- Tasks that edit the same file are never both marked [P].

---

## Slice 0: Docs and constitution (this spec's own docs-only PR; blocks every other slice)

**Purpose**: the amendment both issues' own top-of-body decision names as "implementation work" --
done once, here, not re-litigated per later PR.

- [x] T001 Write `specs/014-side-chat/spec.md`, `research.md`, `plan.md`, `data-model.md`,
  `contracts/ipc.md`, `quickstart.md`, `future/open-questions.md`, `checklists/requirements.md`.
- [x] T002 Amend `.specify/memory/constitution.md`: Principle I drops `/btw` from the "supplies
  natively" list; Principle II replaces the `runEphemeralTurn`/`btw-ext.ts` rule with the native
  RPC contract; Principle IV raises the minimum supported OMP version to 18.6.3; Platform and
  Stack's extension-ships-with-the-app sentence is corrected (no extension ships); version bumped
  1.9.0 -> 2.0.0 (MAJOR: redefines Principles I, II, IV, Governance's own rule).
- [x] T003 Amend `specs/001-core-session-workspace/contracts/omp-usage.md`'s Failure handling
  table: the version-check row raised from "`18.4.x` or `18.5.x`" to the 18.6.3 minimum, citing
  FINDINGS items 14 and 49 and the already-recorded B5 decision.
- [x] T004 [P] `pnpm check:indent`-equivalent scan (`node scripts/check-indent.mjs`) on every
  touched file.

**Checkpoint**: the docs-only PR merges before Slice 1 starts; `docs/PLAN.md` row C2 is NOT
touched here (that is Slice 3's own Checkpoint task, after the feature actually ships).

---

## Slice 1 / Phase 1: Shell and hosting (blocks Slices 2 and 3)

**Purpose**: a real, rail-reachable panel with an empty-thread state and a composer, no RPC wiring
yet -- independently verifiable (the icon appears, the panel opens, nothing crashes), same
incremental-shippability spec 013's own Slice 1 used.

- [x] T005 Add `'side-chat'` to `PanelId` and a descriptor (`MessageCircleIcon`, `hasCount: false`)
  to `HOSTED_PANELS` in `src/renderer/features/right-pane/panel-registry.ts` (data-model.md,
  research.md decision 5). `MessageCircleIcon` is already used elsewhere in this codebase
  (`FdbKnowledgePanel.tsx`'s own "Ask" sample row icon), confirming it reads correctly for a
  conversational interaction.
- [x] T006 Create `src/renderer/features/right-pane/side-chat/SideChatPanel.tsx`: an empty-thread
  state plus a composer (Enter sends, Shift+Enter newline, matching the main composer's own
  behaviour per issue://1), no RPC call yet (stub `onSend` prop). Follows whichever Session the
  chat pane currently shows, no independent binding of its own (unlike Subagents' rail-click
  ambiguity).
- [x] T007 Edit `RightPaneShell.tsx`: one more `activePanelId === 'side-chat'` branch rendering
  `SideChatPanel` (depends on T005, T006).
- [x] T008 [P] `pnpm typecheck` and `pnpm build`; fix any error before proceeding. Both pass;
  vitest 376/376, check:indent 0 odd-indent (316 files), check:ui-text 0 leaks (371 files),
  check:theme-contrast 313/313 no new token, check:drag-regions 0 violations (108 files).

**Checkpoint**: live-verified in an isolated scratch Electron instance (own `--user-data-dir`/CDP
port, scratch repo/registry with one seeded Session -- never touching Stuart's live Sessions;
process exit confirmed by pid), 7 named screenshots, sha256-checked, 0 duplicates, under
`C:/Users/shopwood/refract-live-check-1-516-shell/`. The Side chat rail icon appears (fourth
icon, after Agent Builder); the launcher lists all four panels in order (Subagents, FDB
Knowledge, Agent Builder, Side chat); opening it shows the empty-thread state and a composer.
**A real finding, corrected before this checkpoint closed**: the first verification pass used a
registry with no Session at all, so the composer's own `disabled={!sessionId}` left it inert the
whole time -- Shift+Enter and plain Enter both produced an empty value because nothing was ever
typed into a disabled field, not because of a real behaviour difference. Re-run with one seeded
Session open: the composer is not disabled, Shift+Enter correctly inserts a newline
(`"line one\nline two"`, measured via the textarea's own `.value`, not asserted from a screenshot
alone), and a plain Enter correctly clears the draft (the stub `onSend` fired with no crash at
the time -- Slice 2 below replaces this stub with `useSideChatStore`'s real `ask`, so this
sentence is now historical). The
two-tab bar (Side chat + FDB Knowledge) and all-four-tab bar (adding Subagents and Agent Builder)
both render correctly; closing all four returns to the same four-entry launcher. No regression to
the other three panels.

---

## Slice 2 / Phase 2: RPC wiring (User Stories 1-3, 5)

**Purpose**: the feature's actual behaviour -- sending, receiving, persisting, cancelling. This is
where the readiness gate's own 18.6.3 version check (if its code is updated alongside, see T009)
starts mattering for real.

- [x] T009 Edit `src/main/readiness.ts`: raise the literal version-match condition and warning
  text from `18.4.x`/`18.5.x` to the 18.6.3 minimum (constitution Principle IV, already amended in
  Slice 0; this task is the CODE catching up to the docs, same split both issues asked for).
  **Live-verified**: a real scratch `omp --version` reported `18.8.6` (newer than the `18.8.0`
  FINDINGS recorded); `readiness.check()` returned `{omp:{ok:true,found:"18.8.6"}}` with no
  `warning` field, confirming 18.8.x is recognised as the specifically re-probed minor.
- [x] T010 [P] Add `BtwDeltaFrame`/`BtwRecordFrame` to `src/shared/frames.ts`'s `KnownFrame` union
  (data-model.md).
- [x] T011 [P] Add `IPC_REQUESTS.SIDE_CHAT_ASK`/`SIDE_CHAT_CANCEL`/`SIDE_CHAT_GET_HISTORY` and
  `IPC_EVENTS.SIDE_CHAT_PATCH` to `src/shared/ipc.ts`, plus `RefractApi.sideChat.{ask,cancel,
  getHistory}` and `onSideChatPatch` (contracts/ipc.md).
- [x] T012 Add `askSideChat(question, recordId?)`, `cancelSideChat()`, `getSideChatHistory()` to
  `SessionAgent.ts`: issue the `btw`/`btw_cancel`/`get_btw_history` RPC requests over the session's
  existing connection; forward `btw_delta`/`btw_record` frames as `SIDE_CHAT_PATCH` events keyed by
  this session's id (depends on T010). **Correction during live verification**: `get_btw_history`
  does NOT return a flat array of independent records as this spec's own `data-model.md`
  originally inferred -- confirmed live, it returns one entry per independent topic/thread, each a
  tree (a root node carrying `id`/`leafId`, plus a nested `followUps[]` whose entries carry no id
  of their own at all). `frames.ts` gained `BtwHistoryNode`/`BtwHistoryThread` for the real shape;
  a new `flattenBtwHistory` helper turns each thread into the flat, ordered `SideChatRecord[]` the
  IPC contract and renderer actually consume, synthesizing a stable `${root.id}.${index}` key for
  a non-root row (safe for React keys and `applyPatch`'s by-id match, never sent back to OMP as a
  `recordId`).
- [x] T013 Create `src/main/ipc/side-chat.ts`: `registerSideChat(manager)` wiring the three
  requests to `SessionAgent`'s new methods, mirroring `chat.ts`'s validation/error-mapping shape
  (depends on T011, T012). (`subagents.ts` does not exist as a separate file -- subagent IPC lives
  inside `chat.ts`; `side-chat.ts` is its own file since `sideChat.*` is its own namespace per
  contracts/ipc.md.) A blank or >10,000-character question is rejected locally before reaching OMP.
- [x] T014 Edit `src/preload/index.ts`: expose `refract.sideChat.*` and `onSideChatPatch` (depends
  on T011).
- [x] T015 Create `src/renderer/state/side-chat-store.ts`: `SideChatThreadState` (data-model.md) --
  `loadHistory`, `ask`, `cancel`, `clearThread`, `applyPatch`, subscribed to `onSideChatPatch` once
  in `init-stores.ts` (mirrors every other event subscription's own central-wiring location, not
  inside the store file itself) (depends on T014). `loadHistory` carries forward the last
  thread's own root `id` as `activeTopicRecordId` (corrected round 3, Code3/Verif3 HIGH: the
  root's own `id`, never its `leafId`, is the real continuation point OMP tracks internally --
  `leafId` was live-tested against a restarted omp process and rejected every time with "Unknown
  /btw topic"; `id` continued the same topic correctly, restart included), not a flattened row's
  synthetic id.
- [x] T016 [P] Export `useSideChatStore` from `src/renderer/state/index.ts` (depends on T015).
- [x] T017 Wire `SideChatPanel.tsx` to `useSideChatStore`: load history on first open per Session
  (FR-004), send through `ask`, show "Thinking" while `running` (FR-005), render the answer through
  the shared `Markdown`/`CodeBlock` components (FR-009), Cancel button issuing `cancel` (FR-006),
  error record rendering with an icon plus text (FR-008) (depends on T006, T015, T016).
  **Critical bug found and fixed during live verification**: the `records` zustand selector fell
  back to a freshly-created `[]` literal when `bySession[sessionId]` was absent -- a new array
  reference on every render fails `useSyncExternalStore`'s equality check, an infinite re-render
  loop (React error #185) that crashed this panel into its error boundary the instant it opened
  for a Session with no side-chat history loaded yet. Fixed with a module-level stable
  `EMPTY_RECORDS` constant.
- [x] T018 [P] Run `pnpm typecheck` and `pnpm build`; fix any error before proceeding. Both pass;
  vitest 376/376 (no new tests, AGENTS.md #605), check:indent 0 odd-indent (318 files),
  check:ui-text 0 leaks (371 files, after rewording three inline comments that happened to survive
  esbuild's minifier unminified in this exact JSX position -- `FR-008`/`FR-009`/`FR-006` replaced
  with `Spec 014:` wording, same information, no banned pattern), check:theme-contrast 313/313 no
  new token, check:drag-regions 0 violations (108 files).

**Checkpoint, round 2 (gate-fix remediation, supersedes the round-1 account below)**: PR #668's
first gate round (Code2/A11y2/Sec2/Verif2) found real Highs in both the code (main-transcript
leak, a stuck-`running` race, no single-flight guard) and the round-1 evidence itself (no
`report.json`, the cancel screenshots did not show a genuinely running question, several claims
had no artifact at all). All were fixed (see T009-T022 above) and re-verified in ONE fresh,
coherent scratch Electron run (own `--user-data-dir`/CDP port 9361, real signed-in `omp 18.8.6`
agent, `github-copilot/Claude Sonnet 5.5`, every process exit pid-verified) against the fixed
build: 15 named screenshots plus `report.json` (every measured value: composer `.value`s, focus
`document.activeElement` before/after Cancel and Send, the live region's own text, `lastMessageCount`
before/after, the raw `get_btw_history` payloads) and `sha256.json` (0 duplicates), under
`C:/Users/shopwood/refract-live-check-668-round2/` (the round-1 folder's own contents superseded
and not reused).
**Confirmed live, this round**:
- Focus lands in the Side chat composer itself (not the generic panel wrapper) the instant it
  opens via the rail -- two layered bugs found and fixed by tracing every real
  `HTMLElement.focus()` call live: a parent/child effect-ordering race (`setTimeout(0)` defers
  past it), and the textarea being `disabled` while history was still loading, which silently
  swallowed the first `.focus()` attempt (only `Send` is gated on `loaded` now).
- Enter/Shift+Enter/Escape on BOTH composers, real recorded `.value` (`"line one\nline two"` then
  `""`).
- A real `btw` round trip (Thinking shown, Cancel button appears, terminal answer "4" rendered),
  `sessions.list()`'s own `lastMessageCount` for this Session read and confirmed unchanged
  (SC-001) -- a stronger, more precise signal than the round-1 account's full-body-text diff
  (which was comparing against ambient, unrelated UI text like token-usage percentages).
- **Cancel of a GENUINELY running question**, the round-1 gate's own specific complaint: a fresh
  question polled for the Cancel button at a 100ms cadence, clicked the instant it appeared
  (`16-genuinely-running-before-cancel-click.png`: "Thinking…" plus both Cancel and Send
  visible), and the terminal "Cancelled." row plus focus still on the textarea confirmed after
  (`17-genuinely-running-after-cancel-click.png`) -- `document.activeElement` read as the
  textarea both before AND after the click, confirming focus never dropped to `body` when the
  Cancel button itself unmounted.
- The no-Session empty state ("No Session open" / "Open a Session to ask a side question.").
- History persists across a kill (`taskkill`, pid-verified) + relaunch **for a Session whose main
  conversation was already started** -- both the original answer and a same-session follow-up
  both showed correctly after the restart.
- The composer's local `/btw <question>` interception (unchanged from round 1, re-confirmed:
  draft clears only after `ask` resolves, nothing reaches the main transcript).
- Four-tab geometry at 240/320/520, reworded per A11y2's own correction: Default (320px)
  truncates "Subagents" and "Side chat" to a single glyph each (not "no ambiguity" as round 1
  claimed) -- told apart only by icon and tooltip, added to #650; Min is icon-only with a
  scrollbar; Max is clearly distinguishable.
**Two NEW findings from this round's own live testing** (both honestly carried forward, neither
guessed-fixed): `future/open-questions.md` item 5 (history not shown after a restart for a
Session that never sent a main message, reworded this round per Verif2) and **item 6, newly
found**: continuing a topic's own `recordId` (the `leafId` `get_btw_history` reports) fails with
OMP's own `"Unknown /btw topic"` once the process has been restarted, even though the history
content itself loads correctly -- `leafId` appears to be a volatile, process-lifetime identifier.
Refract's own error handling degrades safely (toast, draft preserved, no corruption); the
underlying OMP-side mechanism for resuming a topic across a restart, if one exists, is unknown.
**Not live-verified this round** (disclosed, not guessed): FR-008's Retry button actually
rendering against a real OMP `status: "error"` record -- the one live-reachable failure mode
tried (a bogus `recordId`) produced an RPC-level rejection (a toast), never a renderable error
record, so Retry's own structural correctness is typecheck/build-verified only, not live-exercised
against real OMP data; the live region's own announced text (checked once, read back empty --
timing of the check, not re-verified with a longer wait); `btw_delta` streaming (still 0 frames
observed across every probe run including this one); screen reader behaviour; `axe`/automated
accessibility scan. All added to #650.

<details>
<summary>Checkpoint, round 1 (superseded by round 2 above -- kept for history, not a current claim)</summary>

live-verified in an isolated scratch Electron instance (own `--user-data-dir`/CDP
port 9357, scratch repo + two seeded Sessions via `repositories.add`/`sessions.create`, never
touching Stuart's live Sessions; every process exit confirmed by pid), real signed-in `omp 18.8.6`
agent (`github-copilot/Claude Sonnet 5.5`). 21 named screenshots, hash-checked (certutil SHA256,
`Get-FileHash` unavailable on this machine's PowerShell), 0 duplicates, under
`C:/Users/shopwood/refract-live-check-1-516-shell/` (the 7 superseded Slice-1 files and their
`report.json`/`sha256.json` deleted first by literal path, per the "one coherent run" rule).
**Confirmed live**: a real `btw` round trip (question sent, "Thinking" shown, Cancel button
appears, terminal answer rendered through `Markdown`, main transcript provably unchanged -- same
text before and after); Enter/Shift+Enter/Escape on BOTH composers with real recorded `.value`
(not screenshots alone); the no-Session empty state ("No Session open" / "Open a Session to ask a
side question."); Cancel issued against an acknowledged running request returns cleanly to idle
(no stuck "Thinking"); history persists across a kill (`taskkill`, pid-verified) + relaunch
against the same `--user-data-dir` **for a Session whose main conversation was already started**
(`currentConversation` set) -- `get_btw_history` correctly returned the prior question/answer/
`leafId` after the restart; the composer's local `/btw <question>` interception (FR-007): typed in
the main composer, the draft clears, nothing is added to the main transcript, and the question
correctly lands in the Side chat panel with a real answer; four-tab geometry at 240/320/520 (the
existing `WidthPresetControl` Min/Default/Max buttons) -- Min is icon-only with a horizontal
scrollbar (no label text, so no ambiguity); Default (320px) reproduces the previously-flagged
finding that "Subagents" and "Side chat" truncate to visually similar labels (`"S.."` vs `"S."`,
confirmed via `[role="tab"]` text content, not merely eyeballed) with no real overlap or clipping
of either tab's own close button or count -- added to #650, no redesign attempted per Main's own
qualifier; Max (520px) shows every label clearly distinguishable.
**A real, substantive finding, NOT fixed this round (an OMP/SessionAgent architecture question,
not a guess to patch blind)**: `get_btw_history` did NOT find prior side-chat history across a
restart for a Session that had ONLY ever been used for side-chat questions, never a single main
composer message (`currentConversation` stays `null` the whole time) -- `SessionAgent.
attachAndVerify` only issues `switch_session` when `session.currentConversation` is set, so a
restarted process in this specific edge case has no Conversation file to reattach to at all, and
`get_btw_history` legitimately finds nothing (confirmed: the original btw-history JSON file itself
was still present on disk at `~/.omp/agent/sessions/<session>/<conversation>/btw-history/
entry-<id>.json`, so this is NOT data loss, only a lookup-scope question). A realistic Session
(main conversation started before or alongside the first side question, the normal case for any
real developer) does not hit this -- confirmed by the SAME restart test on a second scratch
Session that had sent one real main message first, which persisted correctly. Flagging this as an
open question for Stuart/a future round rather than guessing a `switch_session` target with no
conversation file to name.
**Not live-verified this round**: `btw_delta` streaming (still 0 frames observed across every
probe run including this one -- every answer arrived as a single terminal `btw_record`, same as
FINDINGS item 14); screen reader behaviour; `axe`/automated accessibility scan. Added to #650.

</details>

---

## Slice 3 / Phase 3: UI polish and full verification (User Story 4, Polish)

**Purpose**: the composer-level `/btw` entry point, per-answer actions, and the cross-slice gate
and live verification the assignment requires before a PR is called ready.

**T019 and T020 were pulled forward into the Slice 1+2 round above, per Main's own decision** (the
composer-level `/btw` entry point is the natural way to actually exercise Slice 2's `ask`/`cancel`
live, and Main's remediation instructions explicitly named it) -- both done and live-verified, see
their own entries and the Checkpoint above. T021-T027 remain genuinely not started.

- [x] T019 [US4] Edit `src/shared/slash-commands.ts`: add `{ name: 'btw', description: 'Ask the
  agent a side question' }` to `NATIVE_BUILT_COMMANDS` (data-model.md); `btw` stays in
  `NATIVE_RESERVED_COMMANDS` unchanged.
- [x] T020 [US4] Edit `MessageInput.tsx`: intercept `parseSlashCommand(message)?.name === 'btw'`
  before calling `chat.send` (same tier as the existing `/new` interception, research.md decision
  3) -- open and focus the Side chat panel for this Session, and if `rest` is non-empty, call
  `useSideChatStore.getState().ask(sessionId, rest)` (FR-007). **Live-verified**: see the
  Checkpoint above.
- [x] T021a [US5] Add a Retry action to an error record (FR-008, spec.md User Story 5 Scenario 3
  -- missed in the original T017 pass, found by Verif2's round-2 gate review: FR-008 and the
  spec's own acceptance scenario were neither built nor tracked). A blank question never reaches
  OMP at all (rejected client-side in `side-chat.ts` before any record exists), so every
  `status: "error"` record actually rendered here is, by construction, one OMP's own contract
  allows resending -- Retry re-issues the same question text via `ask`, disabled while another
  question is running.
- [ ] T021 [P] Add a Copy action to a completed answer (FR-011, issue://466's existing pattern) and
  a Clear thread action (FR-003's own "omit `recordId`" reset, clearing only Refract's displayed
  history for that Session).
- [x] T022 [P] Add a polite live region announcing a completed answer once (FR-012), and focus
  management: the panel's composer gains focus on open (rail, launcher, or `/btw`); focus returns
  to the triggering control on close (FR-013, same shared pattern spec 013's panels already use).
  **Built in round-2 gate remediation** (A11y2 HIGH/Medium, not originally in Slice 1+2's own
  scope, pulled forward alongside the other fixes): an always-mounted `role="status" aria-live=
  "polite"` region, clear-first-then-set (mirrors `chatAreaAnnouncer.ts`), announcing once per
  record transition out of `running`; `role="alert"` removed from historical error records so
  opening a Session with past errors does not announce them assertively; a new `textareaRef` plus
  `right-pane-store.ts`'s `sideChatFocusRequestId` (bumped on every `openPanel('side-chat')` call)
  move focus into the composer on open via the rail, the launcher, or `/btw`, including a `/btw`
  while the panel is already active; Cancel focuses the textarea before cancelling (its own
  button unmounts the instant `running` clears) and `send()` refocuses it after the draft clears
  (Send itself becomes `disabled` on an empty draft, which would otherwise drop focus to `body`).
  Focus-returns-to-the-triggering-control-on-close is the PRE-EXISTING shared mechanism spec 013's
  other three panels already use (`PanelTabBar.tsx`/`hosted-panel-actions.ts`), unchanged here.
- [ ] T023 [P] Run `pnpm check:ui-text` against the built bundle; fix any leaked spec term.
- [ ] T024 [P] Run `pnpm check:theme-contrast`; confirm no new `token missing` row (research.md
  decision 7 -- no new token expected).
- [ ] T025 [P] Run `pnpm check:drag-regions` if present on the implementation branch's base.
- [ ] T026 Full [quickstart.md](quickstart.md) pass in an isolated scratch Electron instance (own
  `--user-data-dir`, real signed-in OMP 18.6.3+ profile, never Stuart's live Sessions): every
  story's numbered steps, including a real live `btw` round trip, a restart-survival check
  (quit/relaunch against the same worktree), and the `/btw` composer path.
- [ ] T027 Update `docs/PLAN.md` row C2 only: status, branch, PR number (minimal diff, this story's
  own row) (depends on T026 passing).

**Checkpoint**: every quickstart.md story passes; the gate commands above exit 0; `docs/PLAN.md`
row C2 reflects the real PR.

---

## Dependency summary

- Slice 0 (T001-T004, docs-only) blocks every later task -- the constitution amendment must land
  before any implementation PR opens.
- Slice 1 (T005-T008) depends on Slice 0 and on spec 013 (merged, #665).
- Slice 2 (T009-T018) depends on Slice 1.
- Slice 3 (T019-T027) depends on Slice 2 for T020-T022 (they need a working `ask`/panel); T019 and
  T023-T025 could run earlier but are grouped here to match the assignment's own polish-last slicing.

## Parallel example

Within Slice 2, T010 (frames.ts), T011 (ipc.ts), and T016 (state/index.ts export, once T015 lands)
touch disjoint files and could be split across two agents if the lane ever parallelises; this plan
assumes one agent, one slice at a time, per the "one heavy build at a time" machine constraint
already in force for this session.
