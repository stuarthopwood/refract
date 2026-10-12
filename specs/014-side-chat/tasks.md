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

**Checkpoint, round 11 (comment/doc wording only, supersedes the round-10 account below -- NO
code behaviour change: `git diff da9769f..HEAD` touches only `.md` files)**: PR #668's tenth
gate round (Code11/Sec11/A11y11/Verif11 all PASS) found round 10's own wording corrections were
themselves still incomplete: a MISSING fourth residual gap, two leftover "below" references that
should say "above", and two more wording imprecisions in the gap list itself.

**Found**: (1) `contracts/ipc.md` had its own un-corrected "for as long as that topic remains
unsettled" sentence (round 10 checked ipc.md and concluded it made "no entirely-style claim", but
missed this different overclaim sitting right next to where "entirely" would have been). (2) A
FOURTH residual gap, missed by every round through round 10: `askSideChat` stamps a follow-up's
own `recordId` with the CURRENT epoch BEFORE the `btw` request is even sent, and `side-chat.ts`
passes `recordId` through with no check against it -- an `ask` that races a Conversation switch
can therefore name a topic from the Conversation JUST LEFT, which gets stamped as current right
up until OMP itself rejects it as unknown; a late frame for that same topic arriving in the
meantime would be forwarded instead of dropped (same hypothetical-future-OMP-only caveat as the
other three). (3) Gap (b)'s own account only covered a race against a fast terminal frame -- it
never mentioned that the SAME kind of harmless orphan is left behind when the `btw` request
itself fails after a follow-up's `recordId` was already stamped pre-await (no terminal frame
ever arrives for a failed request either). (4) Gap (a) said a fresh topic's "first frame" is
unstamped, when actually EVERY frame -- delta, running, or terminal -- arriving before the `btw`
response stamps it is unstamped; "first frame" undersold how broad this already-disclosed gap
is. (5) Gap (c) called the renderer's own `!loaded` guard "the only thing covering" that case
without saying it is only PARTIAL cover (it drops an unknown record id only while history has
not yet loaded; once loaded, a late terminal record is appended). (6) Two leftover "see the
round-10 correction below" references, inside round 9's own (already-superseded) text, pointed
the wrong direction now that round 10 sits ABOVE round 9 in this file, not below it.

**Fixed** (wording/doc only, confirmed via `git diff da9769f..HEAD` touching only `.md` files --
NO `src/` change at all this round): `contracts/ipc.md`'s own sentence corrected to match
`data-model.md`'s wording; `data-model.md`'s gap list rewritten with explicit `(a)`-`(d)` labels
matching this Checkpoint's own lettering, gap (d) added, gap (b) extended to cover a failed `btw`
request's own lingering stamp, gap (a) reworded to "frames arriving before" (not "first frame"),
gap (c)'s `!loaded` guard described as partial; both stray "below" references corrected to
"above"; the PR body and a NEW #650 comment updated to match, naming all four gaps as not
live-verified (hypothetical future-OMP ordering only, no live path exists with the bundled omp
18.8.6).

**Record-keeping**: posted a new #650 comment (old ones never edited) naming gaps (a)-(d) and
stating the guard holds "for every stamped topic until it settles"; the PR body's own
"Not live-verified" section now genuinely tracks this on #650 (previously true in spirit, now
literally true). No new decision needed for Stuart. Gate re-run this round: `check:indent` only,
per Main's own narrower instruction for a markdown-only round (typecheck/`check:ui-text` were
not re-run, since nothing under `src/` or any rendered UI string changed).

<details>
<summary>Checkpoint, round 10 (superseded by round 11 above -- kept for history, with inline corrections where it was wrong/incomplete)</summary>

**Checkpoint, round 10 (comment/doc wording only, supersedes the round-9 account below -- NO code
behaviour change: `git diff 9ddcecb..HEAD -- src` is comment lines only)**: PR #668's ninth gate
round (Code10/Sec10/A11y10/Verif10 all PASS) found two wording-only issues in round 9's own
account of its own fix -- the code itself was already correct, confirmed independently by all
four reviewers tracing every case (running frame, terminal frame for a current/stale topic,
re-stamped follow-up, `btw_delta`, `onExit` timing, epoch-bump sites) by hand.

**Found (1)**: `right-pane-store.ts`'s own round-9 comment described the WRONG case. The code
(`listsChange ? !focus : get().suppressNextContentFocus && !focus`, UNCHANGED this round) only
preserves a pending `suppressNextContentFocus: true` across a SECOND, same-tick `{ focus: false
}` open of the already-open, already-active panel -- a second `{ focus: true }` call correctly
clears it (the caller explicitly asked for focus, so that intent wins over an earlier, still-
pending suppression). The round-9 comment said the fixed case was a second `focus:true` open,
backwards from what the formula actually does.

**Found (2)**: round 9's own docs (`data-model.md`, this Checkpoint's prose, the PR body) claimed
the settledness-based cleanup "closes the window entirely". That overclaims by three residual
gaps, all against the SAME hypothetical future OMP ordering this whole guard protects against,
none live-verified (the bundled omp 18.8.6 settles before a switch ever runs, so none of these
are reachable today): (a) a fresh topic's own FIRST frame, arriving before `askSideChat`'s own
`btw` response stamps it, is unstamped and treated as current by design (round 6's own original
behaviour, unrelated to rounds 7-9) -- the same treatment any never-asked topic already gets;
(b) `askSideChat`'s own post-await `set` (once the `btw` response itself resolves) is
unconditional, so it can re-add an inert, already-settled entry if a terminal frame for the SAME
topic arrives here first (a fast settle racing a slower `btw` response handler) -- an orphan
nothing deletes again until the next `onExit`, harmless (the frame that raced it was still
handled correctly; the leftover is memory-only); and (c) `OmpProcess` emits `exit` from the
child's own `'exit'` event, so a few already-buffered stdout frames can in theory still reach
`onFrame` after `onExit`'s own clear -- these would be treated as current, with the renderer's
own `!loaded` guard in `applyPatch` the only thing left covering that narrow case. Round 9's own
"can never race" claim about the re-stamp (gap (b) above) was also simply wrong.
**Corrected round 11 (Code11/Sec11/A11y11/Verif11)**: this account was itself still incomplete
-- a FOURTH gap existed that nobody had named yet (a follow-up's own `recordId`, stamped CURRENT
before its `btw` request is even sent, can race a Conversation switch and get rejected by OMP as
unknown only after a late frame for the old topic could already have been forwarded); gap (a)'s
"first frame" undersold that EVERY frame arriving before the stamp is unstamped, not just the
first one; gap (b) never mentioned a failed `btw` request leaves the same class of orphan; and
gap (c)'s `!loaded` guard is only PARTIAL cover, not "the only thing left covering" implying
complete. See the round-11 Checkpoint above for the corrected, complete `(a)`-`(d)` list.
`contracts/ipc.md` also turned out to have its OWN un-corrected overclaim this round missed.

**Fixed**: reworded (NO logic touched) the `right-pane-store.ts` comment, the `SessionAgent.ts`
`onFrame` `btw_record` comment, `data-model.md`'s own correction paragraph, and this Checkpoint
itself (replacing the round-9 account's own two inaccuracies in place, same convention every
prior round has used for a self-correction) plus the PR body, to say exactly what the code does:
the guard closes the late-frame window for every STAMPED topic until it settles, not "entirely",
with the three residual gaps above disclosed by name. `contracts/ipc.md` was checked and found
to make no "entirely"-style claim needing correction. **Corrected round 11: this was also
wrong** -- `ipc.md` had a DIFFERENT overclaim ("for as long as that topic remains unsettled")
sitting right next to where "entirely" would have been; checking only for the literal word
missed it.

**Record-keeping**: no new #650 comment needed (this round touches no live-verification claims
or checklist items, only the accuracy of a defense-in-depth mechanism's own documentation). No
new decision needed for Stuart. Gates re-run, matching Main's own exact 3-gate list for this
comment-only round: `pnpm typecheck` (both tsconfigs), `check:indent`, `check:ui-text` (run via
a throwaway `pnpm build` solely to produce its own input, cleaned up after) -- all pass; vitest,
`check:theme-contrast` and `check:drag-regions` were not re-run.

</details>

<details>
<summary>Checkpoint, round 9 (superseded by round 10 above -- kept for history, not a current claim)</summary>

**Checkpoint, round 9.** PR #668's
eighth gate round (Code9/Sec9/A11y9/Verif9 all PASS) found one unanimous Medium: round 8's "keep
one generation" fix for `sideChatTopicEpoch` was wrong in EXACTLY the same way round 7's
immediate prune was -- just with a bigger window.

**Found**: a topic stamped at epoch `e` survives the FIRST Conversation switch (current becomes
`e+1`; the prune only removes entries `< e`, so this one stays and its late frame is correctly
dropped, `e < e+1`). A SECOND switch (current becomes `e+2`) prunes it (`e < (e+2)-1`), so
`onFrame` falls back to treating it as current and FORWARDS its late frame -- the exact round-6/
round-8 leak, just needing two switches instead of one to reopen it. The renderer only partly
covers this: `applyPatch` drops an unknown record id while `!loaded`, but once the new
Conversation's own history has loaded, a late terminal `btw_record` is appended to its thread
(and, if `complete`, becomes its `activeTopicRecordId`). The round-8 docs' own stated reason
("no live code path ever sends `btw`/`btw_cancel` for a topic that old") was also wrong on its
own terms: the risk is a late INCOMING frame OMP emits, never an outgoing request Refract sends.

**Fixed**: replaced age-based pruning with SETTLEDNESS-based cleanup. `notifySideChatConversation
Changed()` no longer prunes `sideChatTopicEpoch` at all. `onFrame`'s own `btw_record` case now
computes `stale = topicEpoch < sideChatConversationEpoch` as before, but ALSO deletes the topic's
entry once its LATEST TURN (via `latestTurn`, never the root's own possibly-stale status for a
follow-up) reaches a terminal status -- unconditionally, whether the frame itself is forwarded or
dropped -- then returns early if `stale`. A topic with nothing left to hear about needs no entry
at ANY age; one still awaiting its terminal frame is kept regardless of how many Conversation
switches have happened since it was stamped -- closing the window for EVERY STAMPED TOPIC UNTIL
IT SETTLES (not "entirely" -- see the round-11 Checkpoint above for the full, current gap list,
all against the same hypothetical future OMP ordering, none live-verified) -- for the ONE thing
the guard protects: a late frame from OMP for a topic of the Conversation just left. `btw_delta`'s own
case is unchanged (deltas are never terminal, so never delete on one). `onExit` also clears the
whole map unconditionally on every process exit, so a topic whose terminal frame never arrives at
all (the process dies mid-question) cannot linger forever either. A continued topic re-stamps a
fresh entry at `askSideChat`'s own ask-time, before its own `await` -- though that method's OWN
post-await `set` is unconditional too and can race a faster terminal frame for the same topic
(see the round-11 Checkpoint above). Re-confirmed going A->B->A still forwards A's own topics
again once back in A (correct -- those topics belong to the CURRENT Conversation by then).

**Rewrote the rationale everywhere** (the `SessionAgent.ts` field/method comments,
`data-model.md`, `contracts/ipc.md`, this Checkpoint's own round-8 account below, the PR body, a
NEW #650 comment): the guard protects against a LATE FRAME from OMP for a topic of the
Conversation just left, for as long as that topic remains unsettled -- not for "one generation"
or any other switch count. With the bundled omp 18.8.6, `RpcBtwController.close()` settles any
running question strictly before a switch ever runs, so this remains a no-op against live frame
ordering today, not live-verified; it protects only a hypothetical future OMP version that emits
a late frame after a switch instead of before it. Removed every "one generation"/"two or more
Conversations ago"/"no live code path references one that old" sentence -- none of those were
ever the right framing.

**Also fixed** (A11y9/Code9/Sec9 Low, small/cheap): the `/btw` toast lost its "Try again in a
moment." retry guidance when round 8 unified it with `SideChatPanel`'s own persistent hint --
restored as a suffix the toast appends to the shared constant (the hint itself needs no call to
action, since it stays visible the whole time `!loaded`). `right-pane-store.ts`'s `openPanel`
now preserves a same-tick pending `suppressNextContentFocus: true` instead of letting a second
call with unchanged open/active-panel lists silently overwrite it back to `false`
(`listsChange ? !focus : previous && !focus`).

**Record-keeping**: #650 given a new comment (old ones never edited) correcting the round-8
rationale and Verif9's own minor finding about comment 6115046237 (it said "Correcting two
claims" when only one of its two bullets was actually a correction, and "confirmed again this
round" cited no new round-8 evidence -- both reworded). The round-8 Checkpoint below has its own
wrong "Fixed" paragraph corrected in place, same convention as every prior round's self-correction.
</details>

<details>
<summary>Checkpoint, round 8 (superseded by round 9 above -- kept for history, with one inline correction where it was wrong)</summary>

**Checkpoint, round 8.** PR #668's
seventh gate round (Sec8/A11y8/Verif8 PASS with Mediums; Code8 FAIL High) found round 7's own
`sideChatTopicEpoch` pruning (added as a Low fix, to bound its unbounded growth) actually
DISABLED the frame-drop guard it sat right next to, for almost every case that guard exists to
catch.

**Found**: `notifySideChatConversationChanged()`'s pruning loop deleted EVERY
`sideChatTopicEpoch` entry stamped before the new epoch, including entries for the Conversation
just being left. `onFrame` then found no entry for those topics and fell back to treating them
as CURRENT (`?? this.sideChatConversationEpoch`, the same default an ever-unstamped topic
gets), so a late `btw_delta`/`btw_record` for a topic whose `btw` response had ALREADY returned
before the switch (the common case: `ask()` returns almost immediately with a `running` record,
the real answer streams later) was forwarded into the new Conversation instead of dropped --
exactly the round-6 leak this mechanism exists to block, silently reopened by round 7's own
prune. Four places (the code comment, `tasks.md`, `data-model.md`, `contracts/ipc.md`) still
described the guard as working.

**Fixed**: the pruning now keeps one generation back (`stampedEpoch < this.
sideChatConversationEpoch - 1`, never `< this.sideChatConversationEpoch`) -- bounds the map the
same way (an entry survives at most one extra Conversation change past the one it belongs to)
while a topic from the Conversation JUST left stays correctly stamped through the one switch
where a late frame for it could actually arrive. All four docs (plus the PR body and a new #650
comment, never editing the old one) corrected to say exactly this: the guard holds for the
Conversation just left plus the in-flight-ask window a switch can race; with the bundled omp
18.8.6, `RpcBtwController.close()` cancels synchronously before a switch ever runs, so this
remains a no-op against live frame ordering today, protecting only against a hypothetical
future OMP version; a topic from two-or-more Conversations ago is no longer stamped and is
treated as current, which is fine since nothing live ever references one that old.
**Corrected round 9 (Code9/Sec9/A11y9/Verif9 Medium): this "Fixed" account was WRONG in exactly
the same way round 7's own was.** "Keep one generation" just moved the window from one switch to
two; a SECOND Conversation switch still silently pruned the entry and reopened the leak, and "no
live code path references one that old" was the wrong framing (the risk is a late INCOMING frame
OMP emits, never an outgoing request Refract sends). See the round-9 Checkpoint above for the
real fix (settledness-based cleanup in `onFrame`, not age-based pruning).

**Also fixed** (A11y8/Sec8 Low, small/cheap): `SideChatPanel`'s hint and `MessageInput`'s
matching `/btw` toast now share one `SIDE_CHAT_LOADING_HINT` constant -- round 7 claimed the two
wordings already "matched exactly"; they never did (the hint said "Loading side chat
history…", the toast said "Side chat is still loading its history. Try again in a moment.").
`right-pane-store.ts`'s `openPanel` now sets `suppressNextContentFocus` only when the
open/active-panel lists will actually change (it could otherwise linger harmlessly until the
next `openPanel`/`closePanel`). The PR body's "What it builds" bullet for `/btw` now discloses
that focus stays in the main composer while history is still loading.

**Corrected** (evidence honesty -- Code8/Verif8 Medium, raised independently by both, fixed
alongside even though Main's own numbered list did not itemise it separately): round 7's own
account claimed the rapid-switch screenshots "confirmed ... the round-7 Code7 HIGH fix" -- but
round 7's OWN `report.json` already disclosed the stale-epoch retry branch was never
instrumented, and a timing analysis shows both races would very likely reach the SAME end state
even WITHOUT that fix (a local `get_btw_history` round-trip is fast enough that the panel's own
ordinary load effect, not necessarily the retry, most likely handled the reload either way).
Reworded here, in `C:/Users/shopwood/refract-live-check-668-round7/report.json`, and in a new
#650 comment: the END STATE (panel loaded, Send enabled, question answered) was verified;
whether the stale-epoch retry branch itself fired was never observed. Also corrected
`report.json`'s "no icon-rail visible" (the rail IS visible; only the pane was collapsed) and
its "hint/toast" wording (the toast covers/obscures the hint in screenshot 07 -- only the toast
was actually visible).

**Record-keeping**: #650 given a new comment (the old round-7 one never edited); the round-7
Checkpoint below has its own two wrong claims (the pruning description, and the evidence
overclaim) corrected in place, the same convention round 7 used for round 6's false focus claim.
</details>

<details>
<summary>Checkpoint, round 7 (superseded by round 8 above -- kept for history, with two inline corrections where it was wrong)</summary>

**Checkpoint, round 7.** PR #668's
sixth gate round (Code7/A11y7 FAIL with Highs; Sec7/Verif7 PASS with Mediums/Lows) found two
fresh defects in round 6's own fix, plus confirmed round 6's "focus stays in the main composer"
claim was never actually true.

- **HIGH (Code7) -- the panel could get stuck on "not loaded" forever.** A `loadHistory` call
  still in flight when a Conversation change bumped the epoch correctly returned without a
  `set` (round 6's own fix), but nothing then started a FRESH load for the Conversation now
  current -- the panel's own load effect depends on `[sessionId, loaded, sessionStatus,
  loadHistory]`, and `loaded` was already `false` (no change) while a Conversation switch never
  touches `sessionStatus`, so Send/`/btw` stayed permanently refused as "still loading" until
  the Session's live status happened to change on its own. **Fix**: the stale branch now kicks
  off a fresh `get().loadHistory(sessionId)` when still `!loaded` -- that call captures its OWN
  epoch, so this can never loop forever.
- **HIGH (A11y7, also Code7/Sec7 Medium) -- `/btw`'s own "keep focus in the main composer"
  fix never actually worked.** `openPanel('side-chat', { focus: false })` only suppressed
  `sideChatFocusRequestId` (the side-chat TEXTAREA'S OWN focus request); `RightPaneShell`'s
  separate, unconditional "focus the newly opened panel's content" effect still ran for ANY
  genuinely new panel open, regardless of that flag -- exactly the common case (pane collapsed,
  or the side-chat tab not already open) `/btw`'s own `!loaded` gate hits. Round 6's own
  screenshot 05 already showed the tell (a focus-visible outline on the side-chat content
  region), but report.json/the PR body/this tasks.md all claimed the fix worked anyway. **Fix**:
  a new one-shot `suppressNextContentFocus` flag on `right-pane-store.ts`, set by
  `openPanel(id, { focus: false })` and consumed (always cleared on read) by `RightPaneShell`'s
  effect, which now skips `contentRef.focus()` when it is set -- re-verified live this round
  with a real `document.activeElement` assertion (see below), unlike round 6's own claim.
- **Medium (Code7/Verif7)**: `askSideChat` now captures `sideChatConversationEpoch` BEFORE
  `await`ing the `btw` request, not after it resolves -- stamping with the epoch current once
  the RESPONSE arrives (round 6's own code) could give a question asked in the Conversation just
  left the NEW epoch if a switch landed while it was still in flight, defeating the defense in
  depth for exactly the case it exists for; a continued topic's existing `recordId` entry is
  re-stamped with the captured epoch too, before awaiting, matching this method's own doc
  comment (and `tasks.md`'s prior, inaccurate "stamped at ask-time" claim -- now actually true).
- **Medium (Code7/A11y7/Sec7)**: `ask`'s failure branch no longer shows a "Side question
  failed" toast (or keeps the question as the NEW Conversation's own draft) when the request
  settles stale -- the question belonged to the Conversation just left, so neither makes sense;
  the caller's own success path (clearing its draft) runs instead, same as a stale SUCCESS.
- **Low (Code7/Sec7)**: `SessionAgent.sideChatTopicEpoch` is pruned inside
  `notifySideChatConversationChanged()` -- every entry stamped before the bump is deleted
  (a topic belonging to the Conversation just left), instead of growing by one entry per side
  question for the whole life of the agent. **Corrected round 8 (Code8/Sec8/Verif8 HIGH/
  Medium): this was WRONG.** Deleting every entry for the Conversation just left broke the
  frame-drop guard for the main case it exists to catch (a topic whose `btw` response had
  already returned before the switch) -- round 8's own "keep one generation" fix was ALSO wrong
  in the same way; see the round-9 Checkpoint above for the real fix (settledness-based cleanup).
- **Low (A11y7)**: `SideChatPanel`'s own `!loaded` hint now has a third branch -- a running
  Session reloading after a Conversation change showed "available once the Session is running"
  (wrong: it already is running), which also disagreed with `MessageInput`'s own matching `/btw`
  toast; now `loadError` / `stopped` / "Loading side chat history…", matching exactly.
  **Corrected round 8 (Code8/A11y8/Sec8/Verif8 Low): "matching exactly" was false** (two
  independently-worded strings) -- round 8 replaces both with one shared
  `SIDE_CHAT_LOADING_HINT` constant so they cannot drift again.

**Re-verified live** (`C:/Users/shopwood/refract-live-check-668-round7/`, 19 screenshots -- one
disclosed pixel-identical pair, 11/15, both a fresh never-asked Conversation's own empty panel --
`report.json`, `sha256.json`, real `omp 18.8.6`), a FRESH scratch worktree (`round7-fresh`, not
`lucky-martin`, to avoid any pre-existing conversation ambiguity): `/btw` with the side-chat pane
fully COLLAPSED beforehand (the exact condition round 6's fix missed) -- `document.activeElement`
asserted via CDP immediately after the toast to be the MAIN composer's own textarea, not the
side-chat content region; two rapid "New conversation" clicks (~110ms apart) and, separately,
opening the panel for the very first time then switching Conversation ~52ms later -- BOTH races
end with the panel loaded and Send enabled, confirmed by a fresh question succeeding each time
-- **corrected round 8 (Code8/Verif8 Medium): "(the round-7 Code7 HIGH fix)" overclaimed this.**
The end state (loaded, Send enabled, answered) was genuinely verified; whether the stale-epoch
retry branch itself fired, rather than the panel's own ordinary load effect handling the reload
either way, was never instrumented or observed -- disclosed as such in `report.json` all along,
just not reflected in this sentence until round 8. Stop, then open an EARLIER Conversation from
history (not "New conversation" -- the other branch of the stopped-Session fix, untested in
round 6 and wrongly described as untestable in round 6's own report.json) -- the panel correctly
reloaded that
Conversation's own row and correctly continued its existing topic (not a fresh one) once asked
again. A raw `window.refract.sessions.list()` dump (sessionId + `currentConversation`) was
captured for the switch-back assertion this round, closing round 6's own narrative-only gap.

**Record-keeping**: #650 updated with what this round exercised versus what remains untested
(screen reader/axe/`sideChatInterrupted`/Retry-on-error/btw-history-notice/raw-`btw_delta` carry
over unchanged; the main/renderer epoch-drop defense-in-depth paths remain logic-verified only,
confirmed again this round to be no-ops against the real OMP 18.8.6 ordering). No new decision
needed for Stuart. The round-6 Checkpoint below is corrected in place (not rewritten) where its
own "focus stays in the main composer" claim was false.
</details>

<details>
<summary>Checkpoint, round 6 (superseded by round 7 above -- kept for history, with one inline correction where it was false)</summary>

**Checkpoint, round 6.** PR #668's
fifth gate round (Code6/Sec6/A11y6/Verif6 all FAIL with Highs) found round 5's own fix reached
`SessionAgent.startNewConversation`/`openConversation` but never `conversationSwitch.ts`'s
`startStoppedSessionOnConversation` -- the ONLY Conversation-switch path available while
`status === 'stopped'` (`ConversationSwitcher.tsx`'s `canSwitch` allows New conversation/Open an
earlier Conversation from a stopped Session too). Stop, then switch Conversation, reproduced the
exact "Unknown /btw topic" defect round 5 claims to have fixed, through another door. Reviewers
also DISAGREED about whether a side question still running when the Conversation changes can
leak into the new Conversation (Code6/A11y6/Sec6: no, OMP's own `RpcBtwController.close()`
cancels and settles it first; Verif6: yes, OMP only cancels lazily on the next `ask()` call) --
resolved this round both by reading the bundled omp 18.8.6 source directly (readable,
non-obfuscated, file-path-commented) and by a live race test (below): Code6/A11y6/Sec6 were
right -- `close()` is awaited by the RPC host strictly BEFORE `new_session`/`switch_session`/
`branch`/`fork` itself runs, and it cancels + synchronously pushes the terminal
`btw_record(cancelled)` frame before that command's own response. Verif6's "still running;
cancel it first" message lives in `ask()`'s own guard, which fires only for a SECOND `/btw` in
the SAME unchanged Conversation, never during a switch.

**Fixed**: `conversationSwitch.ts`'s `startStoppedSessionOnConversation` now reads the Session's
PREVIOUS `currentConversation` before the registry write and, if the Conversation actually
changed, calls a new `SessionAgent.notifySideChatConversationChanged()` -- the single place that
both emits `sideChatConversationChanged` and bumps a new `sideChatConversationEpoch`, used by
`startNewConversation`/`openConversation` too now. Three defense-in-depth layers added for the
switch-while-running race (regardless of the empirical finding above, since OMP's own ordering
could change in a future version): (1) `SessionAgent` issues a best-effort `cancelSideChat()`
before `new_session`/`switch_session` in both conversation-change methods; (2) `SessionAgent`
stamps every topic's root id with the epoch at ask-time (`sideChatTopicEpoch`) and `onFrame`'s
`btw_delta`/`btw_record` cases drop a frame stamped with an older epoch instead of forwarding it;
(3) the renderer's `side-chat-store.ts` gained a module-level `epochBySession` map (kept outside
`clearThread`'s own deleted entry) that `loadHistory`/`ask` capture before their one `await` and
skip their own `set` entirely if it changed, `?? before` fallbacks replaced with
`?? EMPTY_SESSION_STATE`, and `applyPatch` ignores an unknown record id while `!loaded`. (This
description was accurate for what round 6 itself shipped; round 7's own LOW fix later broke
layer (2) via over-aggressive pruning, and round 8 restored it -- see the round-8 Checkpoint
above for the real account of what `sideChatTopicEpoch` does today.)

**Medium/Low fixes**: `SideChatPanel`'s seed effect now resets `seededSessionsRef` the instant
`loaded` drops (a Conversation change), re-arming seeding for the reload instead of leaving the
Session's id seeded forever and announcing a reloaded Conversation's last row as brand new
(WCAG 4.1.3). `right-pane-store.ts`'s `openPanel` gained a `{ focus?: boolean }` option; `/btw`
from the main composer now opens the panel with `focus: false` while `!loaded`, so the draft and
focus both stay in the main composer instead of stealing focus into an empty side-chat textarea,
and picks its toast wording from state (`loadError`, a stopped Session, or a genuine in-flight
load) instead of always claiming "still loading"; a bare `/btw` (no question) is now checked
before the `!loaded` gate, so it no longer raises an error toast for just opening the panel.
**Corrected round 7 (A11y7/Code7/Sec7 HIGH): the "focus both stay in the main composer" claim
above was FALSE.** `openPanel`'s own `focus:false` only suppressed `sideChatFocusRequestId` (the
side-chat TEXTAREA'S OWN focus request); `RightPaneShell`'s separate, unconditional "focus the
newly opened panel's content" effect still moved focus out of the main composer whenever the
pane was collapsed or the side-chat tab was not already open (the common first-`/btw`-of-run
case) -- confirmed live by round 7's own CDP `document.activeElement` assertion, which this
round-6 account never actually captured. See the round-7 Checkpoint above for the real fix
(`suppressNextContentFocus`).
`loadError` now clears the instant a NEW load attempt starts, not only on that attempt's own
success, matching its own doc comment. `contracts/ipc.md`'s `SIDE_CHAT_CONVERSATION_CHANGED` row,
spec.md item 6, data-model.md's `SideChatThreadState` section and its own "Clear thread" UI-action
mention (no such action exists) all corrected; the PR body's "both send `new_session`" line
corrected to "`new_session`/`switch_session`" (`openConversation` sends `switch_session`).

**Re-verified live** (`C:/Users/shopwood/refract-live-check-668-round6/`, 22 screenshots -- one
disclosed pixel-identical pair, 12/15, both an unchanged reload of the same Conversation A --
`report.json`, `sha256.json`, real `omp 18.8.6`), one coherent run, through the REAL UI, with
`sessionId`/`currentConversation` asserted via `window.refract.sessions.list()` at the key step
(not DOM/screenshot alone, closing round 5's own evidence gap): asked Q1 in Conversation A
(settled, `25`); sent a real main message so A has a history entry; clicked New conversation --
the already-open panel self-cleared immediately; asked Q2 in B through the panel's own composer
(settled, `63`); opened Conversation history and switched to A -- dialog closed, main pane showed
A's own message, side-chat reloaded A's own Q1 row, `sessionId`/`currentConversation` asserted to
match A exactly; created a second new Conversation (B2) with its own main message, asked via
`/btw` from the composer this time (settled, `81`); switched to A again (pixel-identical to the
first visit, disclosed) then REVERSED back to B2 (reloaded B2's own `81` row) -- a full round
trip proven in both directions. Stopped the Session; clicked New conversation from the STOPPED
state (the fix's own target path) -- the panel cleared immediately, mid-"Starting agent"; once
idle, asked a question -- SUCCEEDED (`15`), not "Unknown /btw topic". Raced a switch against an
in-flight question: sent a question, clicked New conversation ~74ms later (measured); the panel
showed its own empty state immediately and STILL showed it 3s later (long past when that
question would have settled either way) -- no leaked answer or cancelled record ever appeared in
the new Conversation; a fresh question asked there afterward succeeded (`42`), confirming the new
Conversation's own topic was never left poisoned.

**Record-keeping**: no new decision needed for Stuart this round (round 5's per-Conversation
scope decision is unaffected); this round's fixes and docs corrections are recorded here and in
the PR body only.
</details>

<details>
<summary>Checkpoint, round 5 (superseded by round 6 above -- kept for history, not a current claim)</summary>

fourth gate round (Code5 HIGH; Sec5/A11y5/Verif5 PASS with Mediums/Lows) found round 4's own
critical fix was correct but incomplete: OMP scopes `btw` topics PER CONVERSATION (the OMP
session file, `btw-history/sessions/<getSessionId()>`), not per Refract Session as spec.md/
data-model.md originally assumed -- `RpcBtwController` reopens its own history store whenever
that file changes. Refract's side-chat store was keyed by Session only and never cleared on
"New conversation" or opening an earlier Conversation (both send `new_session` in the SAME
process): the panel kept showing the PREVIOUS Conversation's rows, the next question sent its
topic id, and OMP rejected it with "Unknown /btw topic" -- the exact symptom round 3/4 both
investigated as a restart problem, never a same-process Conversation-switch problem.

**Fixed**: a new `sideChatConversationChanged` event, emitted from `SessionAgent.
startNewConversation` (after `new_session` succeeds) and `openConversation` (after reattach is
verified, skipped when the Conversation is unchanged), wired through `SessionManager`/
`register.ts`/preload/`init-stores.ts` to call `useSideChatStore.getState().clearThread
(sessionId)` -- the panel's own effect then reloads history fresh for whichever Conversation is
now current.

**Medium/Low fixes**: `loadHistory`'s merge no longer lets a stale FETCHED copy of a turn that
was still `running` when `get_btw_history` was called overwrite a NEWER or already-terminal
STORE copy (the likeliest trigger: `/btw` opening the panel for the first time starts
`loadHistory` and `ask` together, racing a live settle). `/btw` from the main composer now also
checks `loaded`, not just `running` (a `/btw` typed before history finishes loading, most likely
right after a restart, used to silently start a fresh topic instead of continuing the real one).
The focus-request effect's stale `if (!loaded) return` gate (left over from when the textarea
WAS disabled, long since removed) is deleted -- it could defer a focus request indefinitely,
moving focus into the panel mid-task later instead of never. Retry now also respects `!loaded`,
matching Send; a `loadError` flag gives the `!loaded` hint honest wording when the real problem
is a permanent `get_btw_history` failure, not an agent that simply has not started yet; the
scroll-into-view effect now also tracks a streaming answer's own growing length, auto-scrolling
only within ~48px of the bottom for an update on the SAME row (a brand-new row always scrolls).
`contracts/ipc.md`'s Events table gained the missing `SIDE_CHAT_INTERRUPTED` row (shipped round
4, never documented) alongside the new `SIDE_CHAT_CONVERSATION_CHANGED` one. `lastRoot` is now
found via `id === topicId`, not `leafId !== undefined` (which worked only by accident -- OMP's
own schema allows `leafId: string | null`). The "topic no longer available" toast no longer
claims a new one was auto-started. `stripInternalPrefix` now also strips an `OmpProcess:`
prefix (a mid-request process exit/timeout). `latestTurn`'s own callsite in the `btw_record`
case is guarded against a missing `record`, matching `askSideChat`'s existing guard. `side-
chat.ts`'s `cancel`/`getHistory` validation messages are plain English now too, matching `ask`'s
own round-4 fix (an edit here briefly dropped `getHistory`'s own `notFound` check -- caught and
restored before committing).

**Re-verified live** (`C:/Users/shopwood/refract-live-check-668-round5/`, 8 screenshots --
02/03 disclosed pixel-identical, the panel had already self-cleared by the time 02 was taken --
`report.json`, `sha256.json`, real `omp 18.8.6`), through the REAL UI: asked a side question in
Conversation A (settled correctly); clicked "New conversation"; the ALREADY-OPEN side-chat panel
self-cleared to its own empty state with NO manual re-trigger (confirmed: 0 rows, no trace of
the old question, the real empty-state text); asked a NEW question in Conversation B through the
real Send button -- it SUCCEEDED (not "Unknown /btw topic"); opened the Conversation history
dialog and switched back to Conversation A -- its side-chat panel correctly reloaded showing
Conversation A's own original row again (confirmed via a direct DOM read of the panel's own
record rows, not just a screenshot).

**Record-keeping**: `spec.md` item 6 and `data-model.md`'s `SideChatThreadState` section
corrected to per-Conversation scope; `contracts/ipc.md`'s "Non-IPC" section updated to match;
`future/open-questions.md` item 6 corrected (the safety net's own narrowed wording, and
`leafId`'s now-known meaning, both left stale since round 4). A short decision-changed note
posted on issues #1 and #516 (the per-Conversation scope correction).
</details>

<details>
<summary>Checkpoint, round 4 (superseded by round 5 above -- kept for history, not a current claim)</summary>

third gate round (Code4/Verif4 CRITICAL, Sec4/A11y4 PASS-ish with Mediums + one HIGH record-
keeping gap) found that round 3's own fix, while correct about WHICH id continues a topic, never
actually reached the renderer at all: OMP's live `btw`/`btw_record` response is the SAME
whole-topic tree `get_btw_history` returns (confirmed live, round 3's own captured
`ask2_followup_response_preRestart` evidence already showed this, previously unnoticed) -- a
follow-up's own response still carries the ROOT's `question`/`answer`/`status`, with the new
turn nested at `followUps[last]`. Refract passed this raw tree straight to the renderer, so EVERY
follow-up (every question after a topic's first answer) silently merged into the root row instead
of appearing as its own new one: no "Thinking", the single-flight guard off, a second Send hitting
OMP's own "still running" rejection, and the round-3 safety net then wiping the topic. A second
High: `get_btw_history` returns topics NEWEST first, so `loadHistory`'s own `reverse().find(...)`
picked the OLDEST topic after a restart, not "the most recently started" as round 3's own comment
claimed -- round 3's own evidence already showed every follow-up landing on the older of two
topics. A third High: round 3's evidence/record-keeping overstated itself (a readiness-screen
screenshot's own near-identical duplicate standing in for the real "answer landed" claim, and the
SC-002 decision said to be "recorded for Stuart" on three issues that had no such comment).

**Fixed this round**: `SessionAgent.latestTurn` (new, reuses `flattenBtwHistory`) normalises
every live `btw`/`btw_record` response to its actual latest turn, with a new `topicId` field
(the topic's own root id) added to `SideChatRecord`; `applyPatch` matches a `btw_delta` by
`topicId` + `status: 'running'` (its own `recordId` is always the topic root, never a follow-up's
flattened id) and sets `activeTopicRecordId` from `topicId` on `complete`; `getSideChatHistory`
sorts topics ascending by `createdAt` before flattening. `BtwDeltaFrame`'s own wire field is
`delta`, never `textDelta` (round 3's own rename fixed nothing -- it renamed the WRONG field).
The safety net now clears `activeTopicRecordId` only on the specific `"Unknown /btw topic"`
rejection (round 3's own blanket-clear-on-any-failure wiped the topic for a transient "still
running"/`agent-not-running` error too). A `sideChatInterrupted` event, emitted unconditionally
at the top of `SessionAgent.onExit`, closes the one exit path (`setPendingMode` -> `restart`)
that never reaches `status: 'stopped'` at all, so `reconcileInterrupted` now fires for it too.
A btw-history save-failure `notice` (`source: 'btw-history'`) now routes to the side-chat
store as a toast, never the main transcript. A11y: a muted status line (`aria-describedby`)
explains why Send is disabled while `!loaded`; the newest record scrolls into view on ask/settle
(`prefers-reduced-motion` respected). Toasts no longer leak `btw failed:`/the IPC channel name;
"Unknown /btw topic" renders as plain English.

**Re-verified live, this round** (`C:/Users/shopwood/refract-live-check-668-round4/`, 11 named
screenshots -- all unique, 0 duplicates -- `report.json`, `sha256.json`, real `omp 18.8.6`, every
process exit pid-verified), through the REAL UI (DOM row-count deltas, never substring matching):
a first question (1 row, correct answer); a follow-up via the Send button (a genuinely NEW row
appears, "Thinking"/Cancel visible, settles with its own distinct answer -- the exact regression
this round fixes); a follow-up via `/btw` from the main composer (same result, main transcript
unchanged 6/6); a follow-up CANCELLED while running (a correct "Cancelled." row; the answer's own
text was observed growing mid-run -- the first round of this PR to see `btw_delta` actually
reach the UI); a further follow-up straight after the cancel (confirms the topic is still
continuable, not locked); a SECOND, independently-seeded topic; a full app kill+relaunch; a
follow-up sent through the real Send button that correctly landed on the NEWER topic, not the
older one (confirmed by reading both topics' own `btw-history/entry-<id>.json` files on disk
directly, before and after -- the newer topic's own `followUps` array grew, the older one's did
not). Three GitHub comments posted and verified (`gh issue view --json comments`): the SC-002
decision request on [#1](https://github.com/stuarthopwood/refract/issues/1#issuecomment-6113942112)
and [#516](https://github.com/stuarthopwood/refract/issues/516#issuecomment-6113943061), the
not-live-verified checklist on
[#650](https://github.com/stuarthopwood/refract/issues/650#issuecomment-6113945611).

**Not live-verified this round** (disclosed, not guessed): screen reader behaviour; `axe`/
automated accessibility scan; the NEW `sideChatInterrupted` event path specifically (no reliable
way found to trigger an approval-mode restart mid-question in this scratch harness -- logic-
verified only); Retry against a real OMP `status: "error"` record (same gap as every prior
round); the btw-history notice routing (no reliable way found to make OMP's own history save
fail on demand); a real `btw_delta` frame's exact payload (this round's own observation was the
row's text growing in the DOM, not a captured raw frame). All added to #650 (see the comment
above).
</details>

<details>
<summary>Checkpoint, round 3 (superseded by round 4 above -- kept for history, not a current claim)</summary>

second gate round (Code3/A11y3/Sec3/Verif3) found the SAME core defect two different ways: the
restart-lockout round 2 logged as an open question (item 6) was actually a plain bug (seeding
`activeTopicRecordId` from the wrong field), `init-stores.ts` silently dropped every `btw_delta`
frame since round 2's own fix (a one-line omission at the single callsite that fix depended on),
and the round-2 evidence itself had gaps (a readiness-screen screenshot standing in for the real
empty state, SC-001 measured with both counts null, `/btw` from the main composer never actually
exercised). All fixed (see `side-chat-store.ts`/`init-stores.ts`/`SideChatPanel.tsx`/`frames.ts`/
`SessionAgent.ts` changes) and re-verified across TWO scratch passes this round: a surgical
API-level test isolating the exact recordId format, then a full re-run through the real UI.
Screenshots + `report.json`/`sha256.json` under `C:/Users/shopwood/refract-live-check-668-round3/`
(round 2's own folder deleted first by literal path).
**Confirmed live, this round**:
- **The restart-lockout root cause, isolated**: a thread's own root `id`, sent as `recordId`
  after killing and relaunching the agent process, continued the SAME topic correctly (`ok:
  true`, the new question landed as a further follow-up) -- that same thread's `leafId` was
  rejected every time with `"Unknown /btw topic"`. `leafId` was never a volatile-but-sometimes-
  valid id (round 2's own theory); it is simply the wrong field, in every process life. Fix:
  `loadHistory` now seeds from root `id`; `ask`'s failure branch now resets `activeTopicRecordId`
  to `undefined` whenever the id it just sent is rejected and still current, so no wrong id can
  ever lock a Session permanently.
- **The fix, re-verified end-to-end through the real UI** (not a raw API call): a Session with a
  real main Conversation, two prior side-chat questions answered, killed and relaunched three
  separate times across this round's own verification pass -- each time, typing a follow-up in
  the panel's own composer and clicking Send succeeded, correctly continuing the same topic
  (confirmed by reading the panel's own rendered record rows directly: 12 rows total, the last
  three all `"What is 1000 + 1? ... Answer: 1001"`).
- **`/btw` from the MAIN composer**, never actually exercised in round 2 (only re-asserted
  "unchanged from round 1"): typed, the draft held the exact typed text, Enter cleared it, the
  main transcript's own row count was unchanged before/after (7/7, confirming `chat.send` was
  never called), and the answer ("Madrid") landed in the Side chat panel.
- **SC-001, measured with a REAL main conversation present** (round 2's own measurement had both
  counts null -- no main conversation existed yet, a weak signal): `lastMessageCount` 9 before
  and 9 after a side question, unchanged.
- **The no-Session empty state**, recaptured properly this round (round 2's own screenshot for
  this, reused unchanged into round 3 without re-verifying, actually showed the readiness screen,
  not the real empty state) -- confirmed `document.body.innerText` contains `"No Session open"`.
- `init-stores.ts`'s `onSideChatPatch` now forwards `recordId` to `applyPatch` -- re-confirmed
  typecheck/build-clean; no long/slow answer happened to stream during this pass, so a real
  `btw_delta` frame reaching the store live is still not directly observed (same as every round
  before this one, FINDINGS item 14).
- Retry focuses the textarea before issuing the retry (matches Cancel's own pattern); the live
  region now also announces a record that arrives already-terminal without ever being seen
  running first; the Markdown answer wrapper is a `div`, not a `span`; toast messages no longer
  leak the internal `SessionAgent <uuid>:` prefix; announcement timers clear on unmount --
  typecheck/build-verified; not independently live-exercised this round beyond the end-to-end
  flows above (no reachable way found to force a record to arrive already-terminal, or to crash
  the OMP child process specifically without killing Electron itself).
- `contracts/ipc.md` corrected: an unknown `recordId` (and "one already running") are RPC-level
  failures (`ok: false`), never a `status: "error"` record -- confirmed live, this round.
**SC-002 (spec.md Clarification item 13, `future/open-questions.md` item 5)**: met for a Session
with a real main Conversation (shown above); still unmet for a side-chat-only Session (re-
confirmed this round: `get_btw_history` still returns empty after a restart for one, exactly as
item 5 already described) -- an open question for Stuart, not a defect introduced this round.
**Not live-verified this round** (disclosed, not guessed): screen reader behaviour; `axe`/
automated accessibility scan; the `reconcileInterrupted` process-exit reconciliation (no reliable
way found to crash the OMP child process specifically, mid-turn, without killing Electron
itself); Retry rendering against a real OMP `status: "error"` record (same gap as round 2 -- no
live-reachable failure case produces one). All added to #650.
</details>

<details>
<summary>Checkpoint, round 2 (superseded by round 3 above -- kept for history, not a current claim)</summary>

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
</details>

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
their own entries and the Checkpoint above. **T021 and T023-T027 completed in PR #669 (T022
shipped in #668, see its own entry below)** -- gate-fix (round 2, Code1 Low; corrected round 3,
Main): this line used to say "remain genuinely not started", stale the moment the first [x] below
landed; round 2's own fix over-attributed T022 to this PR when it actually shipped in #668.

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
- [x] T021 [P] Add a Copy action to a completed answer (FR-011, issue://466's existing pattern) and
  a Clear thread action (FR-003's own "omit `recordId`" reset, clearing only Refract's displayed
  history for that Session). **Copy**: reuses the shared `CopyButton` (`copy-button.tsx`, issue
  #524) unchanged -- the same icon-only control, tooltip, "Copied" check-state swap, and its own
  built-in polite announcement every other Copy site in this codebase already uses; rendered
  beside a `status: 'complete'` answer only, hidden entirely for an empty one (the same "never
  silently clear the clipboard" convention `CodeBlockHeader`/`Markdown.tsx` already follow). No
  new dependency: `CopyButton` already existed. **Clear thread**: a NEW
  `clearDisplayedThread(sessionId)` store method, deliberately distinct from the existing
  `clearThread` (used only for a Conversation change, which also drops `loaded` back to `false`
  and re-triggers a `get_btw_history` refetch) -- `clearDisplayedThread` clears `records`/
  `activeTopicRecordId` but leaves `loaded` `true`, so the cleared view is not immediately undone
  by a refetch bringing the SAME (never-deleted -- spec.md User Story 2 Scenario 2: no delete RPC
  exists) history straight back; only a genuine Conversation change or a full Refract restart
  ever shows it again. The button disables while `running` (clearing out from under an in-flight
  answer would let it silently reappear once it settles -- `applyPatch` re-appends any record id
  it has not seen while `loaded` stays `true`) or once `records.length` is already 0. Focuses the
  textarea BEFORE clearing (same `handleCancelClick`/`handleRetry` pattern -- the button
  disabling the instant `records` empties would otherwise drop focus to `<body>`), and announces
  "Thread cleared." through the panel's existing live region (WCAG 4.1.3 -- a silent clear has no
  other confirmation for a screen-reader user). `data-model.md`'s `clearThread` doc comment
  corrected: it used to say "there is no separate Clear thread UI action", true when rounds 5/6
  wrote it, false now that this task has shipped. **Gate round 2 (Code1 HIGH/Medium, PR #669)**:
  (1) HIGH -- Cancel unmounting (cancelled, or the answer settling) slid Clear thread right into
  Cancel's own screen position in a `justify-end` row, so a double-click on Cancel (or a click
  landing just as the answer settled) could hit Clear thread by mistake and empty the whole
  thread with no undo; fixed with `className="mr-auto"` on Clear thread, anchoring it on the
  left regardless of whether Cancel renders -- Cancel unmounting now leaves an empty gap instead.
  (2) Medium -- a terminal `btw_record` can settle (clearing `running`) before `ask`'s own `btw`
  request resolves, briefly re-enabling Clear thread while `ask` is still in flight for the topic
  being cleared; without an epoch bump, `ask`'s eventual resolution re-appends the reply's own
  `running` placeholder record Clear just removed, a stuck "Thinking" row. Fixed:
  `clearDisplayedThread` now calls `bumpSideChatEpoch` (like `clearThread` already does) and
  writes `running: false` explicitly; does not retrigger a reload (`loaded` untouched, the epoch
  is read only by in-flight `loadHistory`/`ask` calls). (3) Medium docs -- neither doc comment
  said that after a reload (a Conversation change or a restart) `loadHistory` sets
  `activeTopicRecordId` back to the newest root, so the next question after a reload continues
  the pre-Clear topic, not a fresh one; added to both `data-model.md` and `side-chat-store.ts`'s
  own `clearDisplayedThread` doc comment. (4) Low -- extracted the duplicated clear-first-then-set
  announcement timer dance (shared by the settle-announcement effect and `handleClearThread`)
  into one `announce(text)` helper in `SideChatPanel.tsx`. (5) Low -- added a `Tooltip` to Clear
  thread. **Corrected round 3 (Main)**: a disabled native `<button>` has `pointer-events: none`
  and cannot take focus, so this tooltip can never open while Clear thread is disabled -- it only
  appears while the button is ENABLED, and explains that clearing is a temporary hide, not a
  deletion; it does not state the reason for being disabled while `running` (Cancel sits next to
  it as the obvious action there).
  **Re-verified live** (fresh scratch instance, `C:/Users/shopwood/refract-live-check-669-
  round2/`, 5 files + sha256.json, 0 duplicates): captured Cancel's own screen rect before
  clicking it (`cx` 1142.9), clicked it, then queried `document.elementFromPoint` at that EXACT
  same screen position afterward without moving the pointer -- it resolved to a plain `DIV` (the
  row's own flex gap), not a button, confirming nothing clickable slides under the pointer where
  Cancel used to be; Clear thread's own rect at that point measured `cx` 974.5, unchanged from
  its pre-cancel position **visually** (compare `r2-01-running-before-cancel.png` vs
  `r2-02-cancelled-pointer-left-at-old-cancel-pos.png`) -- only the AFTER-cancel rect was ever
  recorded in `report.json`; no separate before-cancel measurement of Clear thread's own rect
  exists to compare it against numerically, so "unchanged" here is a visual claim only, not a
  numeric one. This confirms the `mr-auto` anchor holds. Separately, polling every
  `[role="status"]` element (7 exist on the page; an earlier single-element query had read the
  wrong one, which is why the first live check reported an empty string) for up to 2.5s after
  clicking Clear thread captured the real text: `"Thread cleared."`, appearing within about 100ms
  -- the previously-disclosed "not verified" gap for this specific assertion is now closed. **Not
  measured live**: the action row's layout at the 240px Min pane-width preset -- estimated only
  (approximately 223px of composer content width available, approximately 217px needed by Clear
  thread + Cancel + Send combined, about 6px spare, so the row should not wrap) but never run
  against the real built app at that width; see
  [#650](https://github.com/stuarthopwood/refract/issues/650#issuecomment-6116003780).
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
- [x] T023 [P] Run `pnpm check:ui-text` against the built bundle; fix any leaked spec term. **0
  leaks found across 371 files** -- no fix needed.
- [x] T024 [P] Run `pnpm check:theme-contrast`; confirm no new `token missing` row (research.md
  decision 7 -- no new token expected). **All 313 pairs across 3 themes PASS**, no new token row:
  T021's new controls (`CopyButton`, the "Clear thread" `Button`) both reuse existing tokens
  already covered by this check.
- [x] T025 [P] Run `pnpm check:drag-regions` if present on the implementation branch's base.
  **Present; 0 violations found across 108 files.** T021's new composer-row button sits inside
  the composer's existing `no-drag-region` wrapper; no new header-shaped row was added.
- [x] T026 Full [quickstart.md](quickstart.md) pass in an isolated scratch Electron instance (own
  `--user-data-dir`, real signed-in OMP 18.6.3+ profile, never Stuart's live Sessions): every
  story's numbered steps, including a real live `btw` round trip, a restart-survival check
  (quit/relaunch against the same worktree), and the `/btw` composer path. **Done for this
  slice's diff** (gate-fix wording, round 2, Verif1 Low): Story 3 (restart survival) and Story 1
  Scenario 4 (mid-stream overlap) rely on PR #668's own rounds 3-7, already live-verified there
  and unchanged by this PR's Copy/Clear-thread-only diff, so not re-run here. **Live-verified**
  (scratch clone under `C:/tmp/refract-side-chat-polish` -- never `C:/Repos/personal` -- own
  `--user-data-dir`/CDP port 9341, torn down by pid-verified `taskkill`, deleted by literal path
  afterward; real `omp 18.8.6`, real `github-copilot/Claude Sonnet 5.5`; one coherent run, 12
  screenshots + `report.json` + `sha256.json` under
  `C:/Users/shopwood/refract-live-check-668-polish/`, 0 duplicate hashes): a first side question
  settled to a real answer ("4") with a Copy action that flipped to "Copied"; a follow-up ("Now
  add 10 to that") correctly carried the first answer's own record id AND the model correctly
  used the carried context (answered "14"); Clear thread correctly omitted `recordId` on the next
  question (asserted via a temporary scratch-only main-process debug log of the exact `recordId`
  argument each `sideChat.ask` IPC call received -- `[undefined, "<topicA>", undefined,
  "<topicB>", "<topicB>"]` across the five questions sent this run, matching the expected
  fresh/follow-up/fresh/follow-up/follow-up pattern exactly); Cancel reached a correctly-rendered
  "Cancelled." with no stuck "Thinking"; `/btw` from the main composer opened and focused the
  Side chat panel, sent the question, and never put the literal text in the main transcript
  (asserted via a DOM check, not just visual inspection). **Not re-verified this round** (posted
  to #650): Story 1 Scenario 4 (mid-stream overlap) and Story 3 (restart survival) -- both
  pre-existing #668 behaviour, unchanged by this round's Copy/Clear-thread-only diff, so not
  re-run; a real screen reader pass (standing limitation, every round). **Gate round 2** closed
  the one gap this round's first pass left open: the Clear-thread announcement timing and the
  Cancel-unmount layout-shift fix are both now live-verified (see T021's own round-2 entry above).
- [x] T027 Update `docs/PLAN.md` row C2 only: status, branch, PR number (minimal diff, this story's
  own row) (depends on T026 passing). **Done**: status cell names branch
  `feat/1-516-side-chat-polish`, PR #668 (merged) and PR #669 (in review), and the still-open
  SC-002 decision gate; the rest of the row's own text untouched. **Gate round 2 (Verif1 Low)**:
  wording corrected to "implementation complete ... decision-blocked" (not "done"), matching
  Main's own exact requested text, since SC-002 remains genuinely unresolved.

**Checkpoint**: every quickstart.md story passes except SC-002 for a side-chat-only Session
(Clarification 13, open decision request on #1/#516, no answer from Stuart yet -- not blocking
per the constitution's Incremental Enhancement rule); the gate commands above exit 0;
`docs/PLAN.md` row C2 reflects the real PR.

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
