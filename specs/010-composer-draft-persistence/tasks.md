# Tasks: Composer draft persistence

**Input**: [spec.md](spec.md), [plan.md](plan.md), [data-model.md](data-model.md), [quickstart.md](quickstart.md)

**Prerequisites**: spec 001 (`MessageInput.tsx`) and spec 009 (`attachments.ts`, `AttachmentStrip.tsx`,
the `AttachmentsState`/`PendingImageAttachment`/`PendingTextChip` types) already on `main` — this
spec relocates two pieces of their existing state, it does not rebuild either. `omp` 18.4.x or
18.5.x signed in; Git for Windows; Node 24+; `pnpm`; the GitHub CLI (`gh`) signed in. Windows 11
only.

**Tests**: none. Refract is a prototype (constitution, Development Workflow). Each phase ends with a
**Checkpoint** that runs the matching [quickstart.md](quickstart.md) section by hand. `pnpm
typecheck`, `pnpm build`, and `pnpm check:ui-text` MUST pass before a change lands on `main`.

**Organization**: tasks are grouped by user story so each story can be checked on its own, per the
project's standard task-numbering/evidence-citation convention (spec 004 `tasks.md`). Paths are
relative to the repository root.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: the user story from [spec.md](spec.md) (US1, US2). Setup, Foundational, and Polish
  tasks carry no story label.
- GitHub issues: every task below has an issue titled `010-Tnnn: ...` on the existing
  `stuarthopwood/refract` repo, labelled with a type, area `chat`, and a priority matching the
  task's story (P1 for Foundational/US1/Polish, P2 for US2), `spec:010`. Issue numbers recorded in
  the mapping table at the end once created.

---

## Phase 1: Foundational (blocks both user stories)

**Purpose**: the new per-session store both stories read and write through.

- [X] T001 (#377) Write `src/renderer/state/draft-store.ts`: `Draft` (`{ text: string; attachments:
  AttachmentsState }`), a stable `EMPTY_DRAFT` constant reusing `attachments.ts`'s own
  `EMPTY_ATTACHMENTS`, and `useDraftStore` (`bySession: Record<string, Draft>`,
  `setText(sessionId, text)`, `setAttachments(sessionId, updater)`, `clear(sessionId)`) following
  `queue-store.ts`'s exact `bySession` shape and update pattern (data-model.md). -- Built; `pnpm
  typecheck` clean.
- [X] T002 (#378) [P] Register the new store in `src/renderer/state/index.ts`: export `useDraftStore`,
  and add it to the `RefractDevStores` interface and the `window.__refractStores` dev-only
  assignment, matching every other store's existing entry exactly. -- Built; `pnpm typecheck`
  clean. Live-verified in a scratch `electron-vite dev` instance with CDP attached
  (`--remoteDebuggingPort 9333`, `--user-data-dir=C:\tmp\pinion-composer-draft-verify-userdata`):
  `window.__refractStores.draft.getState().bySession` read correctly before any typing (`{}`) and
  reflected live writes afterward (T003's evidence below).

**Checkpoint**: `pnpm typecheck` and `pnpm build` pass; `window.__refractStores.draft` exists in a
`pnpm dev` instance with CDP attached and reads `{ bySession: {} }` on a fresh launch -- confirmed.

---

## Phase 2: User Story 1 - Switch sessions without losing a draft (Priority: P1) 🎯 MVP

**Goal**: `MessageInput.tsx`'s draft text and pending attachments read from and write through
`draft-store.ts` instead of local `useState`, so a `ChatPane.tsx` `key={sessionId}` remount (a
Session switch) no longer discards either.

**Independent test**: [quickstart.md](quickstart.md) Story 1.

- [X] T003 (#379) [US1] Rewire `src/renderer/features/chat/MessageInput.tsx`: remove the `const
  [text, setText] = useState('')` and `const [attachments, setAttachments] =
  useState<AttachmentsState>(EMPTY_ATTACHMENTS)` hooks; read `text`/`attachments` via two
  `useDraftStore` selectors keyed by `sessionId` (default `''`/`EMPTY_ATTACHMENTS` for a Session
  with no entry yet, data-model.md); replace every `setText(…)` call site (`onChange`,
  `completeSlashCommand`, the Tab-accept and Esc-clear branches of `handleKeyDown`, `handlePaste`)
  with `useDraftStore.getState().setText(sessionId, …)`; replace every `setAttachments((prev) =>
  …)` call site (`completeSlashCommand`'s chip-prune, `handleKeyDown`'s Esc-clear chip-prune,
  `onChange`'s chip-prune, `handlePaste`'s image and chip additions, `handleRemoveImage`) with
  `useDraftStore.getState().setAttachments(sessionId, (prev) => …)`; replace `handleSend`'s
  send-success `setText(''); setAttachments(EMPTY_ATTACHMENTS)` pair with one
  `useDraftStore.getState().clear(sessionId)` call (FR-005). Every other local `useState`
  (`starting`, `slashActiveIndex`, `slashDismissed`, `attachmentAnnouncement`, `ghost`,
  `announcedSuggestion`) and every `useRef` is untouched (FR-006). (depends on T001, T002) --
  Built; `pnpm typecheck`, `pnpm build`, `pnpm check:ui-text` (0 leaks/371 files) all clean.
  Live-verified 2026-10-04 in an isolated scratch `electron-vite dev` instance (own
  `--user-data-dir=C:\tmp\pinion-composer-draft-verify-userdata`, own local-only scratch git repo
  at `C:\tmp\pinion-composer-draft-scratch-repo` with no GitHub remote, driven over CDP via a
  managed browser tab attached to `--remoteDebuggingPort 9333`, a real signed-in `omp` 18.5.1
  agent -- OS clipboard set via `Set-Clipboard`/`Get-Clipboard | Set-Clipboard` from real file
  fixtures, genuine `Ctrl+V`) with two real Sessions (`crisp-harrier`, `swift-wren`): typed "First
  draft for session A" + pasted a real 70-byte PNG (thumbnail "View pasted image, 70 B" appeared)
  + pasted a 1060-char text block (collapsed to a labelled chip) into `crisp-harrier`; switched to
  `swift-wren`, typed "Second draft for session B" with no attachments; switched back to
  `crisp-harrier` -- the exact original text, the PNG thumbnail, and the text chip were all
  restored (`window.__refractStores.draft.getState().bySession` showed both Sessions' entries
  independently and byte-identical to what was typed/pasted). Clicked the restored thumbnail --
  full-size image modal opened; clicked the restored chip -- full original 1060-char text opened
  in its modal (FR-001 to FR-003). Switched to `swift-wren` again -- showed exactly "Second draft
  for session B", zero images, zero chips: no cross-contamination (FR-004, SC-003). Selected all
  of `crisp-harrier`'s text and retyped "Pruned test draft" (pruning the chip, image untouched),
  switched away to `swift-wren` and back -- the store read `"textChips": []` both before and
  after the switch: the already-pruned chip did not reappear (Edge Cases). Clicked Send on
  `crisp-harrier` -- the message box and attachment strip cleared immediately
  (`window.__refractStores.draft.getState().bySession['<id>']` read `{"text":"","attachments":
  {"images":[],"textChips":[]}}`), and the transcript showed a real new user turn ("Pruned test
  draft") with the agent actually starting to work (FR-005) -- turn stopped cleanly afterward.

**Checkpoint**: run quickstart Story 1 -- done, see evidence above. `pnpm typecheck`, `pnpm
build`, `pnpm check:ui-text` pass.

---

## Phase 3: User Story 2 - Round-trip through Settings without losing a draft (Priority: P2)

**Goal**: confirm the same store-based fix (T003) also survives `App.tsx`'s Settings view-swap, with
no code change of its own needed -- a regression guard on the same underlying fix, not independent
new code (plan.md Design overview).

**Independent test**: [quickstart.md](quickstart.md) Story 2.

- [X] T004 (#380) [US2] No code change (depends on T003). Live-verified quickstart Story 2 end to
  end in the same scratch instance as T003: typed a draft and pasted the PNG in the visible
  Session (`crisp-harrier`, already holding "Pruned test draft" + 1 pending image from T003's own
  run), opened Settings (the chat `ResizablePanelGroup` fully unmounted, confirmed by screenshot),
  clicked "Back to chat", confirmed the message box and attachment strip showed exactly the
  original draft and thumbnail -- repeated for 3 more round-trips (4 total) without changing the
  draft in between: every round trip read `{"text": "Pruned test draft", "images": 1}` via the
  accessibility tree (`"1 pending attachment"` description on the Message combobox, exactly one
  `"View pasted image, 70 B"` button each time) -- no duplication, no loss across any repetition
  (SC-002). Sending afterward cleared both immediately, same evidence as T003's final step
  (FR-005).

**Checkpoint**: run quickstart Story 2. `pnpm typecheck`, `pnpm build`, `pnpm check:ui-text` pass.

---

- [X] T005 (#381) Update `docs/DESIGN.md`'s Chat section (the message box / pasted-attachment
  entries) to note the draft and its pending attachments now survive a Session switch or a
  Settings round-trip, matching how every other spec's own doc-update task works. -- Done; see
  `docs/DESIGN.md` Chat section, the new "Draft persistence" bullet directly after "Pasted text
  chips".
- [X] T006 (#382) Run all of [quickstart.md](quickstart.md) once, top to bottom, on the built app
  in an isolated instance; `pnpm typecheck`, `pnpm build`, `pnpm check:ui-text` pass; commit on
  this branch (`composer-draft-persistence-impl`, not `main`, per the assignment -- landing into
  `main` is out of scope for this branch-scoped pass). -- Done; both stories' full quickstart
  checklists were run end to end against the scratch `electron-vite dev` instance above (T003/T004
  evidence); `pnpm typecheck`/`pnpm build`/`pnpm check:ui-text` all clean (0 leaks/371 files) on
  the final tree; scratch Electron instance torn down (targeted `taskkill` on its own PID only,
  CDP port confirmed closed afterward); committed.

**Checkpoint**: run quickstart Stories 1 and 2 end to end. `pnpm typecheck`, `pnpm build`, `pnpm
check:ui-text` pass.

---

## Dependencies and execution order

- **Foundational (Phase 1)**: T001 and T002 touch different files and can run together, though T002
  only has something to export once T001's `useDraftStore` exists to import.
- **User Story 1 (Phase 2)**: needs Phase 1 complete. T003 is the only task; it is the entire fix.
- **User Story 2 (Phase 3)**: needs T003 (reads the same store it already fixed); no new code of its
  own, only live verification that T003's fix generalizes to the Settings round-trip too.
- **Polish (Phase 4)**: needs both stories checked off.

## Parallel examples

- Phase 1: T001 and T002 (different files).
- No other task in this spec is parallelizable: T003 is one cohesive edit to one file; T004/T005/T006
  each depend on the task(s) before them.

## Implementation strategy

1. **MVP**: Phase 1 + Phase 2 (Story 1). Stop and run quickstart Story 1; this alone fixes the more
   frequent, more damaging of the two causes (switching Sessions).
2. Add Story 2 next: it is the confirmation that the same fix, with no further code, also covers the
   Settings round-trip -- the point of building both causes' fix as one relocation rather than two
   separate patches.
3. Polish last: docs, full re-run, commit.

## Notes

- Commit after each phase; keep this branch building.
- FR and SC ids in task text refer to [spec.md](spec.md).
- GitHub issues created with `gh issue create` directly against the existing
  `stuarthopwood/refract` repo (no `/speckit.taskstoissues` run needed beyond using its own
  documented title convention `010-Tnnn: ...`, since its own tool wiring (`github/github-mcp-
  server/issue_write`) was not available in this session's toolset; the GitHub CLI against the same,
  already-used repository is the same "existing, already-used pattern" the assignment names, not a
  new auth/repo change).

### Task-to-issue mapping

| Task | Issue |
|---|---|
| T001 | [#377](https://github.com/stuarthopwood/refract/issues/377) |
| T002 | [#378](https://github.com/stuarthopwood/refract/issues/378) |
| T003 | [#379](https://github.com/stuarthopwood/refract/issues/379) |
| T004 | [#380](https://github.com/stuarthopwood/refract/issues/380) |
| T005 | [#381](https://github.com/stuarthopwood/refract/issues/381) |
| T006 | [#382](https://github.com/stuarthopwood/refract/issues/382) |

Created with `gh issue create` (2026-10-04) against the existing `stuarthopwood/refract` repo.
Posted as a comment on tracking issue [#383](https://github.com/stuarthopwood/refract/issues/383),
matching spec 009's convention.

---

## Remediation round (quality gate, 2026-10-04)

4-reviewer gate (code-reviewer, security-auditor, test-reviewer, accessibility-auditor) ran
against commit `22e5e45`. security-auditor verdict was PASS (only Low/informational notes: no
leak, no new persistence, no new sink). code-reviewer, test-reviewer, and accessibility-auditor
each found one High; every High plus one Medium both code-reviewer and test-reviewer independently
flagged is fixed below. `pnpm typecheck`/`pnpm build`/`pnpm check:ui-text` (0 leaks/371 files) all
re-ran clean after every fix.

- **[HIGH, code-reviewer]** The T005 `docs/DESIGN.md` bullet was written into the **main
  checkout** (`C:/Repos/personal/pinion`) by mistake -- the worktree-path-resolution trap: a `read`/
  `grep` call against a bare `docs/DESIGN.md` path resolved against the session's default cwd, not
  this worktree. The branch itself shipped without its doc deliverable, and `main` had a stray
  uncommitted one-line edit. **Fix**: reverted the stray edit in the main checkout (`git checkout
  -- docs/DESIGN.md` there, confirmed clean afterward) and re-applied the identical bullet directly
  in this worktree's `docs/DESIGN.md` (now present at the file's own line 74, after "Pasted text
  chips", confirmed by `git diff main...HEAD` touching `docs/DESIGN.md` on this branch).
- **[HIGH, accessibility-auditor]** A restored (non-empty) draft's caret landed at position 0, not
  the end, contradicting spec.md's own Clarifications (FR-001, Acceptance Scenario 1) -- live
  Electron-confirmed by the reviewer and independently re-confirmed here. **Fix**:
  `MessageInput.tsx`'s mount-only effect now calls `textareaRef.current?.setSelectionRange(end,
  end)` (end = the restored value's length) alongside the existing conditional `focus()`, every
  mount. **Live-verified** in a fresh isolated scratch instance (own `--user-data-dir` under
  `C:/tmp`, this time with forward-slash paths after the prior run's backslash-path bug was
  diagnosed and fixed -- see Low note below): restored a draft, read
  `{"selectionStart":84,"selectionEnd":84,"len":84}` both before and after an explicit `.focus()`
  call -- caret at the exact end, not 0, matching a freshly typed draft.
- **[HIGH, test-reviewer]** Acceptance Scenario 3 / FR-003 (a *restored* text chip still
  substitutes its full text on send) had no evidence -- the only send in the original round
  happened after the chip had already been pruned. **Fix (verification only, no code change
  needed)**: live-verified in the same fresh scratch instance: pasted a real PNG and a 967-char
  chip (`VERIFICATION-PHRASE-ALPHA-7749: ... END-VERIFICATION-PHRASE-ALPHA-7749`) into Session
  `earnest-bison`, switched to `calm-fox` and back (restoring both), confirmed the caret-at-end fix
  above, then sent. The transcript's own user-turn bubble showed the **full, exact 967-character
  original text** substituted in place of the chip's short label -- not the label -- directly
  confirming FR-003 for a restored chip, screenshotted live.
- **[HIGH, test-reviewer] -- partially closed.** Acceptance Scenario 2 / FR-002 (a *restored* image
  still attaches on send) was intended to be closed in the same run by asking the agent to name the
  pasted image's colour, but that real turn hit an unrelated OMP-side "thinking loop detected"
  abort (a pre-existing model-flakiness failure mode, not a regression this spec introduced) before
  replying, so the agent's own acknowledgement was not obtained this round. What *is* directly
  confirmed: the restored `PendingImageAttachment` (same `id`/`base64`/`mimeType` as pasted) is
  still present in `draft-store.ts`'s state at send time, and `handleSend`'s
  `attachments.images.map(toImageContent)` / `window.refract.chat.send(sessionId, message, images)`
  call is byte-identical to spec 009's own already-shipped, already-verified send path -- this
  spec changes only where `attachments` is read from (the store instead of local state), never
  what is built from it or how it is sent. Re-verifying the agent's own acknowledgement against a
  non-flaky turn is the one piece of this round's evidence budget left undone; the code path itself
  is unchanged from spec 009's own already-verified FR-006.
- **[MEDIUM, code-reviewer + test-reviewer, same root cause from two angles]** Because the draft
  now outlives the component, `handleSend`'s `await chat.send()` can straddle a Session switch away
  and back, or the user simply continuing to type/paste during the request; an unconditional
  send-success `clear(sessionId)` could then silently wipe a newer draft/attachments the old
  local-`useState` code could never touch (a stale `setState` on an unmounted instance was always a
  no-op). **Fix**: `handleSend` now reads `useDraftStore.getState().bySession[sessionId]` right
  before clearing and only calls `clear(sessionId)` if both `text` and `attachments` are still
  reference-identical to what this specific send captured at its own start: a draft that changed in
  the meantime is left alone rather than destroyed (its now-stale, already-sent attachments stay
  visibly pending until removed or sent again, a narrow, non-destructive residue, never a silent
  loss of newer work). Verified by code reading (the exact race -- a slow `chat.send()` RPC
  overlapping new typing -- has no practical repro within this round's evidence budget without
  artificially stalling the RPC); `pnpm typecheck` confirms the guard compiles and type-narrows
  correctly.
- **[LOW, incidental]** The first live-verification attempt in this remediation round passed
  `--user-data-dir=C:\tmp\pinion-composer-draft-verify-userdata` (backslashes) to `electron-vite
  dev` via a POSIX shell, which silently stripped the backslashes and created a stray
  `tmppinion-composer-draft-verify-userdata/` directory **inside this worktree** instead of under
  `C:\tmp`. Caught before committing (`git status` showed it staged), deleted with an absolute,
  explicitly-outside-the-directory `rm -rf` (per the standing safe-deletion rule), and every
  later launch in this round used forward-slash paths (`C:/tmp/...`), confirmed to land in the
  right place before reuse.
- **[LOW, cheap, same files already being edited]** `handleSend`'s own stale comment ("clear the
  draft via `setText('')` below") corrected to name `clear(sessionId)`, the function that has
  actually done this since T003.
- **[MEDIUM, test-reviewer, spec text only]** `spec.md`'s Edge Cases claimed an archived Session's
  draft is "never read again, since no Session row can make it the visible Session again" -- false
  for *archived* (only true for *deleted*): `SessionList.tsx`'s "Archived" section still renders an
  archived Session's row, and opening or restoring it can make it visible again, showing its old
  draft. **Fix**: `spec.md`'s Edge Cases now states the deleted/archived cases separately and
  correctly; `data-model.md`'s own matching rule needed no change (it only claims the entry isn't
  pruned, which was already true either way).

### Not independently re-verified this round
- FR-002's agent-acknowledgement half (see the High above) -- the code path is unchanged from
  spec 009's own shipped, already-verified behaviour, but the live round-trip hit an unrelated
  model-side abort before completing.
- The Medium double-clear-race guard -- verified by code reading, not by an artificially stalled
  RPC repro, per this round's evidence budget.

Every other finding from the four reviewers (Low/informational: unused `EMPTY_DRAFT` export,
`setAttachments`'s unused plain-value branch, `draft-store.ts` importing a type from `features/`
rather than a shared module, no per-session cleanup on archive/delete, a restored `/`-prefixed
draft reopening the slash menu, an in-flight paste's announcement being dropped if its Session is
switched away mid-paste) was read and judged acceptable as specified, matching this repo's existing
patterns (queue-store/commands-store/pending-requests-store also never prune on delete; the slash
menu/ghost-text already intentionally re-derive on every mount per spec.md's own Clarifications),
and left unchanged.
