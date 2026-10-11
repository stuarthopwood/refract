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
alone), and a plain Enter correctly clears the draft (the stub `onSend` fires, no crash). The
two-tab bar (Side chat + FDB Knowledge) and all-four-tab bar (adding Subagents and Agent Builder)
both render correctly; closing all four returns to the same four-entry launcher. No regression to
the other three panels.

---

## Slice 2 / Phase 2: RPC wiring (User Stories 1-3, 5)

**Purpose**: the feature's actual behaviour -- sending, receiving, persisting, cancelling. This is
where the readiness gate's own 18.6.3 version check (if its code is updated alongside, see T009)
starts mattering for real.

- [ ] T009 Edit `src/main/readiness.ts`: raise the literal version-match condition and warning
  text from `18.4.x`/`18.5.x` to the 18.6.3 minimum (constitution Principle IV, already amended in
  Slice 0; this task is the CODE catching up to the docs, same split both issues asked for).
- [ ] T010 [P] Add `BtwDeltaFrame`/`BtwRecordFrame` to `src/shared/frames.ts`'s `KnownFrame` union
  (data-model.md).
- [ ] T011 [P] Add `IPC_REQUESTS.SIDE_CHAT_ASK`/`SIDE_CHAT_CANCEL`/`SIDE_CHAT_GET_HISTORY` and
  `IPC_EVENTS.SIDE_CHAT_PATCH` to `src/shared/ipc.ts`, plus `RefractApi.sideChat.{ask,cancel,
  getHistory}` and `onSideChatPatch` (contracts/ipc.md).
- [ ] T012 Add `askSideChat(question, recordId?)`, `cancelSideChat()`, `getSideChatHistory()` to
  `SessionAgent.ts`: issue the `btw`/`btw_cancel`/`get_btw_history` RPC requests over the session's
  existing connection; forward `btw_delta`/`btw_record` frames as `SIDE_CHAT_PATCH` events keyed by
  this session's id (depends on T010).
- [ ] T013 Create `src/main/ipc/side-chat.ts`: `registerSideChat(manager)` wiring the three
  requests to `SessionAgent`'s new methods, mirroring `subagents.ts`'s existing shape (depends on
  T011, T012).
- [ ] T014 Edit `src/preload/index.ts`: expose `refract.sideChat.*` and `onSideChatPatch` (depends
  on T011).
- [ ] T015 Create `src/renderer/state/side-chat-store.ts`: `SideChatThreadState` (data-model.md) --
  `loadHistory`, `ask`, `cancel`, `clearThread`, `applyPatch`, subscribed to `onSideChatPatch` once
  at store creation (depends on T014).
- [ ] T016 [P] Export `useSideChatStore` from `src/renderer/state/index.ts` (depends on T015).
- [ ] T017 Wire `SideChatPanel.tsx` to `useSideChatStore`: load history on first open per Session
  (FR-004), send through `ask`, show "Thinking" while `running` (FR-005), render the answer through
  the shared `Markdown`/`CodeBlock` components (FR-009), Cancel button issuing `cancel` (FR-006),
  error record rendering with an icon plus text (FR-008) (depends on T006, T015, T016).
- [ ] T018 [P] Run `pnpm typecheck` and `pnpm build`; fix any error before proceeding.

**Checkpoint**: quickstart.md Stories 1, 2, 3, and 5 all pass live against a real OMP 18.6.3+
process in a scratch instance.

---

## Slice 3 / Phase 3: UI polish and full verification (User Story 4, Polish)

**Purpose**: the composer-level `/btw` entry point, per-answer actions, and the cross-slice gate
and live verification the assignment requires before a PR is called ready.

- [ ] T019 [US4] Edit `src/shared/slash-commands.ts`: add `{ name: 'btw', description: 'Ask the
  agent a side question' }` to `NATIVE_BUILT_COMMANDS` (data-model.md); `btw` stays in
  `NATIVE_RESERVED_COMMANDS` unchanged.
- [ ] T020 [US4] Edit `MessageInput.tsx`: intercept `parseSlashCommand(message)?.name === 'btw'`
  before calling `chat.send` (same tier as the existing `/new` interception, research.md decision
  3) -- open and focus the Side chat panel for this Session, and if `rest` is non-empty, call
  `useSideChatStore.getState().ask(sessionId, rest)` (FR-007).
- [ ] T021 [P] Add a Copy action to a completed answer (FR-011, issue://466's existing pattern) and
  a Clear thread action (FR-003's own "omit `recordId`" reset, clearing only Refract's displayed
  history for that Session).
- [ ] T022 [P] Add a polite live region announcing a completed answer once (FR-012), and focus
  management: the panel's composer gains focus on open (rail, launcher, or `/btw`); focus returns
  to the triggering control on close (FR-013, same shared pattern spec 013's panels already use).
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
