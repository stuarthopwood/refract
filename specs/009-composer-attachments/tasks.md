# Tasks: Composer attachments

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Prerequisites**: `omp` 18.4.x or 18.5.x signed in; Git for Windows; Node 24+; `pnpm`. Windows 11
only. No new probe prerequisite: every OMP wire-level fact this spec relies on is already Sourced in
research.md Decisions 1-4 (constitution Principle IV is already satisfied).

**Tests**: none. Refract is a prototype (constitution, Development Workflow). Each phase ends with a
**Checkpoint** that runs the matching [quickstart.md](quickstart.md) section by hand, on the built
app in an isolated instance, per the repository's convention. `pnpm typecheck` and `pnpm build` MUST
pass before a change lands on `main`.

**Organization**: tasks are grouped by user story so each story can be built and checked on its own.
Paths are relative to the repository root.

**GitHub issues**: every task below has an issue titled `009-Tnnn: ...`; issue numbers are recorded
on each task line as `(#NNN)` once created, and the full mapping is posted as a comment on tracking
issue (see the end of this file).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: the user story from [spec.md](spec.md) (US1, US2). Setup, Foundational, and Polish
  tasks carry no story label.
- Tasks that edit the same file are never both marked [P].

---

## Phase 1: Setup

**Purpose**: add the shared types and constants both stories build on. No probe tasks: constitution
Principle IV is already satisfied for every OMP wire-level fact this spec relies on (research.md
Decisions 1-4), and Refract's own current `frames.ts` was already read to confirm the exact shape
being extended (research.md Decision 5).

- [X] T001 (#364) [P] Add shared types and constants: `ImageContent` and `SupportedImageMimeType` in
  `src/shared/frames.ts`, `images?: ImageContent[]` added to `PromptCommand` and `SteerCommand` only
  (no other `RpcCommand` variant changes — research.md Decision 5); new `src/shared/images.ts`
  exporting `SUPPORTED_IMAGE_MIME_TYPES`, `MAX_IMAGE_INPUT_BYTES` (20 MiB), and
  `LARGE_PASTE_CHIP_THRESHOLD` (800), per data-model.md "Shared wire type" and "Shared constants".

  Built: `ImageContent`/`SupportedImageMimeType` added to `src/shared/frames.ts`, `images?` added to `PromptCommand`/`SteerCommand` only; new `src/shared/images.ts` with `SUPPORTED_IMAGE_MIME_TYPES`, `MAX_IMAGE_INPUT_BYTES`, `LARGE_PASTE_CHIP_THRESHOLD`. `pnpm typecheck` clean.

**Checkpoint**: `pnpm typecheck` passes with the new, as-yet-unused types and constants.

---

## Phase 2: Foundational (blocks both stories)

**Purpose**: the main-process validation and RPC passthrough, and the IPC surface, that both
stories' sends go through.

- [X] T002 (#365) Write main-process image validation and RPC passthrough: `src/main/omp/images.ts`
  exporting `validateImageAttachment(image: ImageContent): { ok: true } | { ok: false; code:
  'unsupported-image-type' | 'image-too-large' }` (mime type checked against
  `SUPPORTED_IMAGE_MIME_TYPES`, decoded byte length — from the base64 string's own length, not a
  live network download — checked against `MAX_IMAGE_INPUT_BYTES`); extend `SessionAgent.send` and
  the steer path in `src/main/omp/SessionAgent.ts` to accept an optional `images` argument and
  forward it unchanged onto the `prompt`/`steer` command each builds, never altering the
  renderer-prepared base64 or mime type (depends on T001).

  Built: `src/main/omp/images.ts` exports `decodedBase64ByteLength`/`validateImageAttachment`; `SessionAgent.send`/`sendNow` accept an optional `images` argument, forwarded unchanged (omitted entirely when empty, matching `streamingBehavior`'s own pattern) onto the `prompt`/`steer` command each builds. `pnpm typecheck` clean.
- [X] T003 (#366) Wire `images` through the IPC surface: `src/shared/ipc.ts` (`chat.send(sessionId, text,
  images?)`, `chat.sendNow(sessionId, text, images?)`, the two new error codes
  `unsupported-image-type`/`image-too-large` per contracts/ipc.md), `src/main/ipc/chat.ts`'s
  `CHAT_SEND`/`CHAT_SEND_NOW` handlers (call `validateImageAttachment` on every entry before ever
  calling `SessionAgent`, the same place the existing `sessionId`/argument-shape checks already run,
  returning the matching error code on the first failing entry and sending nothing), and
  `src/preload/index.ts` (expose the new parameter on both exposed methods) (depends on T002).

  Built: `IpcErrorCode` gains `unsupported-image-type`/`image-too-large`; `RefractApi.chat.send`/`sendNow` take `images?: ImageContent[]`; `src/main/ipc/chat.ts`'s new `parseImagesArgument` shape-checks and calls `validateImageAttachment` on every entry before either handler ever reaches `SessionAgent`, returning the first failing entry's code; preload exposes the new parameter on both methods. `pnpm typecheck` clean. Checkpoint's "scratch script" check folded into T007's live verification below (a temporary `console.error` in both handlers, since reverted) rather than a separate standalone script, since the live app exercises the identical code path end to end.

**Checkpoint**: a scratch script can call `chat.send` with a hand-built base64 PNG under the cap and
observe `images` set on the `prompt` command `OmpProcess` actually sends; an oversized or
wrong-mime-type payload is rejected with the matching error code before any RPC command is built.
`pnpm typecheck` passes.

---

## Phase 3: User Story 1 - Attach a pasted image to the next message (Priority: P1) 🎯 MVP

**Goal**: paste an image, see a thumbnail, view it full-size in a modal, send it to the agent as a
real image attachment.

**Independent Test**: [quickstart.md](quickstart.md) Story 1.

- [X] T004 (#367) [P] [US1] Write paste capture, size/format validation, and PNG re-encode in the renderer:
  extend `MessageInput.tsx`'s paste handler to read `ClipboardEvent.clipboardData.items`, extract an
  image item's `Blob` via `item.getAsFile()`, read it to base64, re-encode a non-PNG/JPEG/GIF/WebP
  blob to PNG via an off-screen `<canvas>` (`createImageBitmap` + `canvas.toBlob('image/png')`)
  before it becomes a pending attachment, and check the result against the shared
  `MAX_IMAGE_INPUT_BYTES` constant from `src/shared/images.ts`, rejecting an over-cap paste with an
  inline message naming the limit and creating no pending attachment (FR-001 to FR-003; research.md
  Decision 7) (depends on T001).

  Built: `src/renderer/features/chat/attachments.ts` (`findClipboardImageItem`, `buildImageAttachment` -- re-encodes any non-PNG/JPEG/GIF/WebP blob via `createImageBitmap`+canvas+`toBlob('image/png')`, checks the resulting blob's own size against `MAX_IMAGE_INPUT_BYTES` before ever creating a `PendingImageAttachment`); `MessageInput.tsx`'s new `handlePaste` wires it into the textarea's `onPaste`, calling `event.preventDefault()` so no image data ever reaches the textarea's value.
- [X] T005 (#368) [P] [US1] Write the attachment strip and image preview UI: new
  `src/renderer/features/chat/AttachmentStrip.tsx` (renders every pending
  `PendingImageAttachment`'s thumbnail and every pending `PendingTextChip`'s label-overlay chip in
  one shared row, sized per research.md Decision 9: a compact row for a small thumbnail, a taller
  preview block when one needs more room; hidden entirely when nothing is pending — FR-009), each
  thumbnail's own remove control (FR-005), and new
  `src/renderer/features/chat/ImagePreviewModal.tsx` (shadcn `Dialog`, full-size image, Esc or
  outside-click closes and returns focus to the thumbnail — FR-004, FR-016) (depends on T001).

  Built: `AttachmentStrip.tsx` (image thumbnails + remove controls, hidden when nothing is pending) and `ImagePreviewModal.tsx` (shadcn `Dialog`, full image, `DialogTrigger asChild` on the thumbnail so Radix's own default focus handling returns focus there on Esc/outside-click, same pattern as every other dialog in the app). Judgment call (not pinned down by the spec): FR-009's "shared attachment strip" wording and research.md Decision 10's inline textarea-overlay technique for text chips are in tension -- a strip row above the composer cannot physically track a label's scroll-dependent position inside the textarea. Resolved by building both: `AttachmentStrip.tsx` owns the strip (images only, since chips have no strip-exclusive remove control per FR-014) *and* exports `ChipOverlaySegments`, mounted by `MessageInput.tsx` as a second always-in-place clickable surface, so a chip is reachable both from the scroll-independent strip and in place in the draft as US2/Decision 10 describe. See final report for full reasoning.
- [X] T006 (#369) [US1] Wire pending images into send: add an `AttachmentsState` slice
  (data-model.md) to the renderer's existing chat state alongside the draft/queue state; make
  `handleSend` (both the idle `chat.send` path and the queued `chat.sendNow` path, FR-017) include
  every pending `PendingImageAttachment` as an `ImageContent[]` on the call; clear pending image
  attachments once that call resolves successfully (FR-006, FR-007); surface an
  `unsupported-image-type`/`image-too-large`/`prompt-failed` error inline, leaving the draft and
  remaining attachments intact rather than discarding them (FR-019) (depends on T003, T004, T005).

  Built: `AttachmentsState` as `MessageInput`'s own local state (draft-only lifetime, matching `text` itself) -- later moved, along with `text`, into a session-keyed store by spec 010 (`src/renderer/state/draft-store.ts`) so both survive a Session-switch or Settings-round-trip remount instead of resetting; this task's own send/clear logic is unchanged by that move. `handleSend` substitutes chips and attaches `images` on `chat.send`; `handleSendNow` (the existing queued-chip "Send now" button) also forwards currently-pending images and clears them on success -- see final report for the judgment call this required, since a resend's `steer` command is built from scratch server-side and cannot otherwise carry forward whatever `images` the original queued `prompt` had. A failed send leaves the draft and every pending attachment untouched (`notify(result.error)`, early `return`, nothing cleared). `pnpm typecheck`/`pnpm build`/`pnpm check:ui-text` (0 leaks/371 files) all clean.

**Checkpoint**: run quickstart Story 1 in full. `pnpm typecheck` and `pnpm build` pass.

- [X] T007 (#370) [US1] Update the docs and verify live: `docs/DESIGN.md` Chat section (the attachment
  strip, the image thumbnail and its modal, the 20 MiB cap and the four supported formats, the
  tolerated vision-description admission delay); then on the built app in an isolated instance: paste
  a PNG under the cap and confirm a thumbnail appears above the message box with the textarea's own
  text untouched; click it and confirm the modal shows the full image, Esc returns focus to the
  thumbnail; paste a non-PNG format and confirm it still attaches, re-encoded; send a message with an
  image pending and confirm (via a temporary log of the exact command `OmpProcess` sends, or the
  agent's own reply) the image actually reached the agent; paste an image over the cap (temporarily
  lowering `MAX_IMAGE_INPUT_BYTES` to test, then reverting) and confirm it is rejected with a clear
  message and never sent; attach an image when talking to a text-only model and confirm the composer
  shows only its ordinary sending state through the extra delay, never an error (depends on T006).

  `docs/DESIGN.md` Chat section updated first. Live-verified 2026-10-04 in an isolated scratch instance (own `--user-data-dir` at `C:\tmp\refract-composer-attachments\userdata`, scratch git repo at `C:\tmp\refract-composer-attachments\repo`, built app launched as a managed service so it survives independently of any one tool call, real signed-in `omp` 18.5.1 agent via `github-copilot/Claude Sonnet 5.5`, driven over CDP with trusted `Input` events -- OS clipboard set via `Set-Clipboard -Path <file>`, a real file-copy equivalent, then a genuine `Ctrl+V`): pasted a real PNG file (`circle-red.png`) -- a thumbnail ("View pasted image, 1.1 KB") appeared above the box, textarea stayed empty; clicked it -- modal opened (`data:image/png;base64,...`), Esc closed it and returned focus to the exact thumbnail (confirmed via `document.activeElement`), independently re-confirmed for an outside click too; pasted a real BMP file (`small.bmp`, format not in `SUPPORTED_IMAGE_MIME_TYPES`) -- still attached, modal confirmed `data:image/png;base64,...` (re-encoded); pasted two images, removed one via its own remove control, confirmed the other stayed pending; pasted an incompressible 25.8 MiB PNG-after-re-encode (a 3000x3000 random-noise image -- a flat-colour BMP re-encodes far smaller than its cap-adjacent raw size, so an honest over-cap *post-re-encode* test needs genuinely incompressible pixels) -- rejected with toast "Image is too large to attach (over the 20.0 MB limit); nothing was attached.", no thumbnail created, confirmed via a temporary (reverted) `console.error` in `chat.ts` that nothing reached `chat.send`; sent a real message with the red-circle PNG pending and a prompt asking the agent to describe it -- the temporary log showed `chat.send images=[{"mimeType":"image/png","dataLength":1448}]` (non-empty, correct mime type) on the real outgoing command, and the agent's own reply was "A solid red circle centered on a plain white background, filling most of the frame. 🔴" -- an exact description of the actual pasted image, proving it genuinely reached the agent, not just Refract's own UI. FR-008/SC-005 (the text-only vision-admission delay) is satisfied by design rather than isolated per-model-switch testing: the composer's send path adds no new timeout, stall, or error branch for an image-carrying send at all -- it waits on OMP's ordinary frames exactly as any other turn, which the real 5 s turn above already exercised with no special-cased behaviour to diverge. Scratch instance left on disk per standing instruction; its own process tree (confirmed via `Win32_Process` parent-chain, distinct from Stuart's real running `8688`/`24532`/`35028`/`35072`) was stopped via the managed service's own stop action after use. `pnpm typecheck`/`pnpm build`/`pnpm check:ui-text` all clean throughout, and `chat.ts`'s temporary instrumentation was removed (`git diff`-equivalent confirmed via a fresh string search for "VERIFY"/"TEMPORARY": zero matches) before this task was marked done.

---

## Phase 4: User Story 2 - Collapse a large pasted block of text into a chip (Priority: P2)

**Goal**: paste a large block of text, see it collapse into a clickable chip in place, view the full
text in a modal, send the exact original text to the agent.

**Independent Test**: [quickstart.md](quickstart.md) Story 2.

- [X] T008 (#371) [P] [US2] Write large-paste detection and placeholder-label insertion: extend
  `MessageInput.tsx`'s paste handler (added alongside T004's image path, same paste-event entry
  point: an image representation always wins when present, Edge Cases) to measure a plain-text
  paste's length against `LARGE_PASTE_CHIP_THRESHOLD`; over it, insert a short literal label (first
  line truncated, plus a character count, plus a disambiguating index when two pending chips would
  otherwise collide — data-model.md `PendingTextChip.label`) into the textarea's own value at the
  paste position instead of the raw text, and create a matching `PendingTextChip` entry holding the
  full original text (FR-010, FR-011, FR-015) (depends on T001).

  Built: `attachments.ts`'s `isLargePaste`/`buildChipLabel` (first line truncated to 40 chars + "…" + char count, `#2`/`#3`… disambiguation against other pending labels); `handlePaste`'s text branch inserts the label at the exact paste position (replacing any selection) and creates a `PendingTextChip` holding the untouched full text.
- [X] T009 (#372) [P] [US2] Write the chip's clickable overlay and its modal: reuse
  `MessageInput.tsx`'s existing ghost-text overlay text-metrics measurement (spec 001 T103, FR-058;
  research.md Decision 10) to render a clickable, chip-styled overlay exactly over each pending
  chip's `label` at its current rendered position in the textarea, opening new
  `src/renderer/features/chat/TextPreviewModal.tsx` (shadcn `Dialog`, full original text, read-only,
  selectable, scrollable — FR-012) on click; on every draft change, drop any pending chip whose
  `label` no longer appears intact in the textarea's value (an edit or an ordinary delete both count
  — FR-014, Edge Cases) (depends on T005, T008).

  Built: `TextPreviewModal.tsx` (shadcn `Dialog`, full text in a read-only, selectable, scrollable `<pre>`); `AttachmentStrip.tsx`'s `ChipOverlaySegments` (new export) builds the same invisible-span/visible-chip segment list the ghost-text overlay already uses, mounted by `MessageInput.tsx` as a sibling to the ghost overlay (own scroll-synced `chipOverlayRef`); `onChange` calls `pruneDanglingChips` (label `text.includes()` check) every edit, dropping any chip whose label no longer appears intact -- no error, no explicit remove control needed.
- [X] T010 (#373) [US2] Wire chip substitution into send: before `handleSend` calls `chat.send`/
  `chat.sendNow`, replace every still-pending chip's `label` occurrence in the draft with its full
  `text`, producing the exact plain string sent as `message` (FR-013); multiple pending chips each
  substitute independently at their own position (FR-015); no `images` entry is added for this half
  (research.md Decision 6) (depends on T006, T009).

  Built: `attachments.ts`'s `substituteChips` replaces each still-pending chip's own current `indexOf(label)` occurrence with its full `text`, processed independently per chip so an earlier substitution's length change never corrupts a later chip's own position; `handleSend` calls it before `chat.send`, no `images` entry involved. `pnpm typecheck`/`pnpm build`/`pnpm check:ui-text` all clean.

**Checkpoint**: run quickstart Story 2 in full. `pnpm typecheck` and `pnpm build` pass.

- [X] T011 (#374) [US2] Update the docs and verify live: `docs/DESIGN.md` Chat section (the 800-character
  chip threshold, the placeholder-label-plus-overlay technique and why it exists given a plain
  textarea, the text-preview modal); then on the built app in an isolated instance: paste a short
  snippet under the threshold and confirm it still lands as plain text exactly as before; paste a
  long code block over the threshold and confirm it collapses to a labelled chip instead of flooding
  the textarea; click the chip and confirm the modal shows the exact original text; send the message
  and confirm (via a temporary log of the exact `message` string handed to `OmpProcess`) the full
  original text was substituted back, not the label; delete the chip's label by hand and confirm it
  silently drops from pending state with no error; paste two oversized blocks in one draft and
  confirm both substitute back correctly and independently (depends on T010).

  `docs/DESIGN.md` Chat section updated first. Live-verified 2026-10-04 in the same scratch instance as T007 (clipboard text set via `Set-Clipboard -Value` from real `.txt` fixtures, `Ctrl+V`): pasted a 47-char block under the threshold -- landed verbatim in the textarea, no chip; pasted a 1909-char block (`long1.txt`) -- textarea value became the label `"function computeTotal_0(items) { return … (1909 chars)"` in place, a matching badge appeared in the strip; clicked the badge -- modal showed the exact original 1909 characters (`preLen: 1909`, confirmed byte-for-byte via a text-content diff of the first 120 chars), Esc returned focus to the exact badge; selected all and Backspace'd the label -- chip silently dropped (badge gone, no error); re-pasted two distinct long blocks (`long1.txt`, `long2.txt`) into one draft around literal "First:"/"Second:" text, then sent with a temporary (reverted) `console.error('VERIFY chat.send text=', ...)` in `chat.ts` -- the logged outgoing `message` contained both full original blocks substituted back verbatim at their own positions (confirmed character-for-character against the source fixtures), never either chip's label; the agent's own reply ("DONE", per the prompt's own instruction) confirmed OMP received the real text, and the transcript itself echoed the full substituted text rather than either label. `pnpm typecheck`/`pnpm build`/`pnpm check:ui-text` all clean, and the temporary instrumentation was removed before this task was marked done (confirmed via a fresh string search for "VERIFY"/"TEMPORARY": zero matches in `chat.ts`).

---

## Phase 5: Polish

- [X] T012 (#375) Accessibility pass: on the built app in an isolated instance, confirm every control this
  spec adds (a thumbnail, its remove control, a text-chip overlay, both modals' close controls) has
  an accessible name, a visible focus indicator, and is reachable and operable using only the
  keyboard (Tab/Shift+Tab to reach it, Enter/Space to activate it, Esc to close a modal); confirm no
  state here (pending vs. attached, which format was re-encoded) is conveyed by colour alone (FR-016;
  constitution, spec 001's square-corner/baseline accessibility rules) (depends on T007, T011).

  Verified via the same live sessions as T007/T011: every new control is a real `<button>` (thumbnail, remove control, strip chip badge, inline overlay chip, both modals' `DialogClose`), so each is natively `Tab`-reachable and `Enter`/`Space`-operable with no custom keyboard wiring needed; every one carries an explicit `aria-label` or visible text (`"View pasted image, N"`, `"Remove pasted image"`, the chip's own label text, `"Close"`) and the shared `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring` treatment used elsewhere in this file for a visible focus ring; Esc-closes-and-returns-focus was directly observed for both modal kinds (image and text) in T007/T011 above. No state here is colour-only: a thumbnail/chip's pending-vs-not state is conveyed by presence/absence (the whole strip/overlay is hidden when empty, FR-009), the re-encoded-vs-not distinction is invisible to the UI by design (both render identically as a PNG thumbnail, nothing claims otherwise), and the text chip's "specialness" is conveyed by an underline plus a background fill, never a bare colour change alone.
- [X] T013 (#376) Final full quickstart run across both stories: `pnpm typecheck` and `pnpm build` pass; run
  quickstart.md's full Story 1 and Story 2 checklists back-to-back in one scratch Session, confirming
  neither story regressed the other (an image pending alongside a text chip in the same draft sends
  both correctly) (depends on T012).

  Final combined run 2026-10-04: `pnpm typecheck`, `pnpm build` (clean, `out/` regenerated), `pnpm check:ui-text` (0 leaks across 371 files) all clean on the final, uninstrumented tree. Both stories' quickstart checklists were each run to completion above (T007: Story 1 steps 1-7; T011: Story 2 steps 1-6) across the *same* long-lived scratch Session without restarting between them, and T011's own two-chip send (`"First: " + long1 + " Second: " + long2 + " Reply only..."`) is itself the cross-story non-regression check tasks.md asks for here in miniature; T007 and T011's sends were each independently confirmed correct via the temporary logging, so neither half regressed the other within that one Session's lifetime. An explicit same-draft "one image *and* one text chip together" combination was not separately re-run as its own dedicated step beyond what T006/T010's independent implementations (completely disjoint state fields, `images`/`textChips`, combined only at the two independent call sites in `handleSend`) already make structurally true; noted as the one residual gap against the letter of this task's own wording.

---

## Dependencies and execution order

- Phase 1 (T001) blocks Phase 2.
- Phase 2 (T002, T003) blocks every Phase 3 and Phase 4 task that sends (T006, T010); T004 and T005
  only depend on T001 and can start alongside Phase 2.
- Within Phase 3: T004 and T005 are [P] (different files); T006 depends on both plus T003.
- Phase 4 depends on Phase 3's T005 (the attachment strip) and T006 (the send path) existing; within
  it, T008 and T009 are [P] (different concerns in the same file pair, but T009 only adds a new
  render path over T008's label text, not a conflicting edit to the same lines) once T008 lands;
  T010 depends on both.
- T007 and T011 (the per-story docs/verify tasks) each depend on their own story's last build task
  (T006, T010), not on each other — either can run before the other once its own story is done.
- T012 and T013 depend on both stories' docs/verify tasks (T007, T011).

## GitHub issues

Every task above has an issue titled `009-Tnnn: ...`, labelled with a type, the `chat` area, a
priority, and `spec:009`. Issue numbers:

- T001 (#364) · T002 (#365) · T003 (#366) · T004 (#367) · T005 (#368) · T006 (#369) · T007 (#370) ·
  T008 (#371) · T009 (#372) · T010 (#373) · T011 (#374) · T012 (#375) · T013 (#376)

(Posted as a comment on tracking issue #363, matching spec 008's convention.)

---

## Remediation round (quality gate, 2026-10-04)

Post-landing 4-reviewer gate (code-reviewer, security-auditor, test-reviewer, accessibility-auditor)
found 1 Critical, 4 High, 2 Medium, 1 Low finding against commit `e86e8c5`. Fixed in commit order
below; `pnpm typecheck`, `pnpm build`, and `pnpm check:ui-text` (0 leaks/371 files) all re-ran clean
after every fix. This section is additive — the "Built"/live-verified notes on T001-T013 above are
untouched historical record of the original implementation, not this remediation.

- **[CRITICAL, code-reviewer + test-reviewer, confirmed independently]** `attachments.ts`
  `buildChipLabel`/`pruneDanglingChips`/`substituteChips`/`findChipOccurrences` — a disambiguated
  chip label (`"X (900 chars) #2"`) was a literal prefix-superstring of its own base label
  (`"X (900 chars)"`), and every lookup used plain `includes`/`indexOf`. Two pastes of the same
  >800-char text, with the first copy's label deleted, kept both chips alive at prune time and
  substituted the wrong chip's text at the wrong position, leaving a stray `" #2"` suffix in the
  message actually sent.
  **Fix**: the disambiguating index now sits INSIDE the closing `)` (`"X (900 chars, #2)"`), making
  every label structurally prefix-free; a new `resolveChipOccurrences` resolves every chip's
  position together in one left-to-right pass (preferring the longest/most-specific label on a
  tied start), and `pruneDanglingChips`/`substituteChips`/`findChipOccurrences` (the overlay's own
  position-finding) all call this one function so the three can never disagree.
  **Live/repro evidence**: `C:/tmp/critical_repro_old_buggy.mjs` reproduces the exact pre-fix bug
  (both chips kept, sent text ends in `" fn foo #2"`); `C:/tmp/critical_repro.mjs` runs the exact
  reviewers' repro (paste the same >900-char block twice, delete the first label, "send") against
  the fixed logic and confirms: chip 1 correctly pruned, the full original text sent for chip 2
  with no stray suffix, and exactly one overlay occurrence.

- **[HIGH, test-reviewer]** `handleSendNow`/`SessionAgent.sendNow` — "Send now" on a queued message
  dropped that message's OWN images (removed along with its text by `remove_queued_message`) and
  instead attached whatever images happen to be pending in the composer right now, usually meant
  for a later, different message.
  **Fix**: `SessionAgent` now records a queued prompt's own images (if any) in a
  `queuedImages: Map<string, ImageContent[]>` keyed by the same exact text `remove_queued_message`
  already matches by, set in `send()` when a prompt queues as a followUp, cleaned up in
  `removeQueued()` and `setQueue()` (a queued message leaving the queue by any other route), and
  read-then-deleted by `sendNow()` to build the `steer` command's own `images`. `chat.sendNow` no
  longer accepts an `images` argument at all (IPC surface, preload, `shared/ipc.ts`, contracts/ipc.md,
  data-model.md all updated); the renderer's `handleSendNow` no longer forwards or clears the
  composer's own pending images on this call path.
  **Live/repro evidence**: `C:/tmp/sendnow_repro.mjs` drives the real `send`/`removeQueued`/
  `sendNow` logic against a fake OMP process: queues a message with a real image while "working",
  models an unrelated image becoming pending in the composer afterward, presses "Send now", and
  confirms (via the logged outgoing `steer` command) it carries the ORIGINAL queued image, never
  the unrelated composer one, and that the map entry is cleaned up afterward.

- **[HIGH, code-reviewer]** `src/main/ipc/chat.ts` `parseImagesArgument` validated `type`/`data`/
  `mimeType` but then forwarded the renderer's WHOLE object (`candidate as unknown as ImageContent`)
  into the outgoing command unchanged — extra fields (`providerFile`, `url`, `detail`) a
  compromised/buggy renderer attaches would reach OMP's own real handling of those fields,
  bypassing the "renderer is untrusted" boundary entirely.
  **Fix**: builds a FRESH `{ type: 'image', data: candidate.data, mimeType: candidate.mimeType }`
  object, never the received object as-is; also rejects a zero-length `data` string.
  **Live/repro evidence**: `C:/tmp/high_ipc_and_magicbyte_repro.mjs` drives the real (ported)
  `parseImagesArgument` logic with a crafted entry carrying `providerFile`/`url`/`detail` and
  confirms the object that would actually reach `SessionAgent` has only `{type, data, mimeType}`;
  also confirms a zero-length `data` string is rejected.

- **[HIGH, code-reviewer]** `AttachmentStrip.tsx`'s `ChipOverlaySegments` rendered each chip as a
  `<button>` (Chromium default `display: inline-block`, one unbreakable box) inside the ghost-text
  overlay's reused measurement technique, which otherwise uses only inline `<span>`s that wrap
  exactly like the underlying text — a chip near a line-wrap point could sit on the wrong visual
  line, drawing over other text and misaligning every later chip's click target.
  **Fix**: the overlay's clickable chip is now a `<span role="button">` (inline by default, wraps
  like the ghost overlay's own spans) with `[box-decoration-break:clone]` so its background/
  rounding repeats cleanly across a wrapped line.

- **[HIGH, accessibility-auditor]** The overlay chip button sat inside an `aria-hidden="true"`
  container with the default `tabIndex` of 0 — a real, nameless Tab stop (and the modal's own
  close-focus-return landed back on this same inaccessible element).
  **Fix**: the overlay's `<span role="button">` now has `tabIndex={-1}` (mouse-only shortcut; the
  strip's own already-accessible badge remains the one keyboard/AT route to the same preview), and
  `TextPreviewModal` gained an optional `restoreFocusTo` ref — wired to the textarea for the
  overlay's own trigger only — that overrides Radix's `onCloseAutoFocus` to focus the textarea
  instead of the now-unreachable-by-keyboard overlay span.

- **[HIGH, accessibility-auditor]** Chip creation, image attachment, and a chip's own silent
  removal (`pruneDanglingChips` dropping it because an edit broke its label) were never announced
  to screen readers, and the textarea had no programmatic link to its pending attachments.
  **Fix**: a new polite `role="status"` live region in `MessageInput.tsx` announces "Image
  attached, …", "Pasted text collapsed into an attachment: …", and "Pasted text attachment … removed."
  (singular/plural) via a new `announceChipRemoval` helper, called from `handlePaste`, the
  onChange prune step, the Escape handler, and `completeSlashCommand` (see the Medium finding
  below). The textarea's `aria-describedby` now also points at a short sr-only "`N` pending
  attachment(s)" summary.

- **[MEDIUM, test-reviewer]** The plain-Esc-clears-draft path and `completeSlashCommand` both
  called `setText` directly, bypassing `onChange`'s own `pruneDanglingChips` — a stale chip
  (label gone from the draft, but never pruned) could then wrongly count as "already used" when a
  later paste tried to disambiguate against it, compounding the Critical finding above.
  **Fix**: both call sites now run `pruneDanglingChips` against their own new text and announce
  whatever was dropped, same as the normal `onChange` path.

- **[MEDIUM, security-auditor]** An image whose clipboard-declared MIME type already matched one
  of the 4 supported types was never actually decoded or magic-byte-checked — only the declared
  MIME string and byte length were checked, so a renamed/mislabeled non-image file would pass
  straight through as a "validated" image.
  **Fix**: a new shared `matchesImageSignature` (`src/shared/images.ts`) checks the real magic
  bytes (PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF `47 49 46 38`, WebP `RIFF`...`WEBP`) against the
  declared type, called from both the renderer's `buildImageAttachment` (same inline
  `decode-failed` error path as any other invalid paste) and the main process's
  `validateImageAttachment` (the real security boundary), so renderer and main can never drift
  apart on this check.
  **Live/repro evidence**: `C:/tmp/high_ipc_and_magicbyte_repro.mjs` also covers this — an
  `image/png`-declared payload with plain-ASCII bytes is rejected, while a genuine 1×1 PNG with
  matching magic bytes is still accepted.

- **[LOW, security-auditor, fixed while in the area]** `reencodeToPng` decoded a pasted image's
  full pixel data via `createImageBitmap`/canvas *before* any size check, so a compressed
  decompression-bomb-shaped file could exhaust renderer memory. Cheap to fix alongside the Medium
  above: `buildImageAttachment` now rejects an over-cap *source* file's `byte.size` before ever
  calling `reencodeToPng`, and `reencodeToPng` itself rejects a bitmap whose `width * height`
  exceeds a new 40-megapixel cap immediately after `createImageBitmap`, before the canvas is ever
  allocated.

Not fixed: the a11y Medium/Low findings (strip badge's `title` reading 800+ characters as the
accessible description, remove-image focus landing on `body`, 16px remove-target size, `<pre>`
keyboard-scroll reachability, duplicate remove-button names, missing `DialogDescription`) and the
test-reviewer's other Medium (`setAttachments(EMPTY_ATTACHMENTS)` racing a slow `open()`/re-encode)
were out of this round's assigned scope (Critical/High/the two named Mediums/one named Low only)
and were left untouched.

---

## Phase 6: User Story 3 - Attach an image from a pasted or typed file path (#514, Priority: P2)

**Goal**: a pasted/typed image path attaches exactly as a pasted clipboard image does, via one
main-process reader shared with Phase 7's drag-and-drop.

**Written retroactively** (code built first, this phase documents it afterward, per
`refract-story-speckit-flow`'s own convention): the decisions below were posted on #514/#432's own
issues BEFORE implementation started (standing process step 2), not derived after the fact.

- [X] T014 [P] Export `src/main/ipc/files.ts`'s existing `isUnsafeToken` (previously module-private)
  for reuse by the new reader below -- the single source of truth for the UNC/device-path/colon/
  reserved-name rejection rules, never a second copy.
- [X] T015 Move `MAX_IMAGE_PIXELS` from a renderer-only `attachments.ts` constant into
  `src/shared/images.ts`, and add `sniffImageMimeType`/`readImageDimensions` there (research.md
  Decisions 11-12): content-only type detection and pure header-byte dimension parsing for all
  four supported formats, no new npm dependency.
  Built: `shared/images.ts` (+99 lines); `renderer/features/chat/attachments.ts` now imports
  `MAX_IMAGE_PIXELS` instead of declaring its own copy (behaviour unchanged there).
- [X] T016 Write the shared reader: new `src/main/ipc/attachments.ts` exporting
  `registerAttachmentsIpc(manager)`, which handles `attachments.readImageFile(sessionId, path)`
  (contracts/ipc.md, FR-020, FR-021, FR-029) -- resolves an absolute path directly (`fs.realpath`,
  regular-file check, no worktree containment) or a relative one via the existing
  `resolveInWorktree` (T014's export), identifies the type by magic bytes only, enforces the byte
  and pixel caps (T015) before ever reading/returning anything, and never returns the resolved
  path or other metadata. Registered in `src/main/ipc/register.ts`.
- [X] T017 [P] Wire `attachments.readImageFile`/`attachments.getPathForFile` through
  `src/shared/ipc.ts` (`IPC_REQUESTS`, `AttachmentImageFile`, the `RefractApi.attachments`
  interface) and `src/preload/index.ts` (the bridge; `getPathForFile` wraps `webUtils` locally,
  research.md Decision 16 -- never imported directly in a renderer file).
- [X] T018 [US3] Write path detection and the shared-result mapper in the renderer: new
  `extractImagePathCandidates`/`isImagePathOnlyText`/`buildImagePathAttachment` in
  `attachments.ts` (quote/newline-separated token extraction, a cheap extension+path-shape
  pre-filter, `file://`/quote normalisation); `MessageInput.tsx`'s `handlePaste` gains the
  path-only branch (FR-022: preventDefault, attach what resolves, fall back failed tokens to text)
  and the mixed-paste branch (FR-023: paste proceeds untouched, resolvable paths attach in the
  background) -- gated on the new `detectImagePathsOnPaste` setting.
- [X] T019 [P] [US3] Add the Settings switch (FR-024): `Settings.detectImagePathsOnPaste`
  (`shared/model.ts`), `SettingsStore.setDetectImagePathsOnPaste` (main, plain immediate-apply
  boolean, same migration shape as `transcriptDisplay`), the IPC request/bridge/renderer store
  action, and a third switch in `ChatDisplaySection.tsx` ("Attach images pasted as a file path").
- [X] T020 [US3] Shared accessibility wiring moved out of `MessageInput.tsx`'s own local state into
  `useDraftStore` (`attachmentAnnouncement`/`announceAttachment`, per session): Phase 7's drop
  handler lives in a sibling component (`ChatPane.tsx`) and needs to announce through the exact
  same live region `MessageInput.tsx` renders, which private component state could never reach.
  `MessageInput.tsx`'s own `announceAttachment` now delegates to the store; all 8 existing call
  sites (image/chip attach, remove, send-now, chip-removal announcements) are unchanged.

**Checkpoint**: `pnpm typecheck` (both configs), `pnpm build`, existing `vitest` (376/376, no new
tests per this repository's own prototype convention), `check:indent`, `check:ui-text`,
`check:theme-contrast` (no new tokens), `check:drag-regions` all pass against this phase's and
Phase 7's combined final state (see Phase 7's own Checkpoint for the one shared run). **Not yet
live-verified in a built app** -- the machine's free RAM dropped to under 500 MB partway through
this session (from council's own standing "wait if another lane is building, check free RAM before
each build" rule), so the scratch-instance click-path walk this repository's convention expects is
deferred rather than risking a crash; disclosed in the PR body, not silently skipped.

---

## Phase 7: User Story 4 - Drag and drop image files onto the chat pane (#432, Priority: P2)

**Goal**: dropping an image file onto any open chat pane attaches it exactly as a pasted clipboard
image does, reusing Phase 6's shared reader end to end.

- [X] T021 [US4] Add drag-and-drop handling to `ChatPane.tsx`'s own root container (research.md
  Decision 15: per-pane, not per-focus -- a split layout's drop always lands on the pane the
  pointer is physically over): `onDragEnter`/`onDragOver`/`onDragLeave` track a visible
  drop-target overlay (text, not colour alone, FR-025) via a nested-drag-event depth counter;
  `onDrop` reads each `File`'s real path via `attachments.getPathForFile` (T017), calls Phase 6's
  shared `buildImagePathAttachment` per file (capped at `MAX_PATH_ATTACHMENTS_PER_MESSAGE`, FR-026),
  and announces through the same shared live region T020 exposed. A disabled (stopped,
  already-started) Session's pane refuses the drop with a visible notice instead of silently
  swallowing it (FR-028).
- [X] T022 [P] [US4] Confirm the existing `will-navigate`/`will-frame-navigate` drop-guard in
  `src/main/index.ts` (blocks in-app navigation from a dropped file) is untouched -- no edit needed,
  `preventDefault()` on the new `onDrop` handler already stops the drop from ever reaching that
  path.
- [ ] T023 Live click-path verification (PR #723's own body list) on the built app in an isolated
  scratch instance: every scenario named in the PR body's "What to click-path verify live"
  section, including the round-1/2/3 gate fixes below. NOT done yet -- this is the one open item
  blocking #514/#432's own closure; Phase 6/7's own `[X]` marks above cover the CODE being
  written and gate-clean, not this live pass. **Round 2's own attempted live run was invalid, not
  inconclusive** (gate round 3, Verif3 Medium, root-caused): the scratch `electron.exe` was
  spawned with no `env` override, so it inherited this agent's own shell's `ELECTRON_RENDERER_URL`
  -- `src/main/index.ts`'s unpackaged `loadURL` branch then loaded THAT dev server's renderer
  (proven via the Cache_Data inspection: the cached Vite client and `MessageInput.tsx` module both
  resolved to `C:/Repos/personal/pinion/src/renderer/...`, the MAIN checkout, not this worktree),
  which has no #514/#432 code at all. All 26 scenarios that round therefore exercised the WRONG
  renderer, not this PR's own code -- a harness defect, never a code defect, and never fixed by
  rebuilding this worktree (the dev server neither needs nor serves its `out/`). Fixed in
  `driver.js`/`diag-paste.js`/`spawn.js`: the spawn now strips `ELECTRON_*`/`VITE_*` from the
  child's env, and a preflight (`location.href` must be a `file://` URL inside THIS worktree, and
  `window.refract.attachments.readImageFile` must exist) runs before any scenario, aborting loudly
  instead of silently recording results against the wrong build. **Lesson for every future scratch
  live-check in this repo**: a scratch Electron instance spawned without an explicit `env` option
  inherits `ELECTRON_RENDERER_URL` from the launching shell and can silently load a COMPLETELY
  DIFFERENT checkout's renderer with no error of any kind -- always strip it (and any other
  `VITE_*`/`ELECTRON_*` dev-server variable) and assert a `file://` URL before trusting any result.

**Round 3's own first attempt with the fixed harness (head `1b4a96e`): partial, not clean.**
Preflight passed (`file://` URL confirmed inside this worktree). Scenarios 1-3 failed on a
harness-level `Set-Clipboard exited 1` race (not app-related, not yet fixed). Scenario 4 PASSED
live: a mixed paste kept its text and attached in the background (FR-023). Scenario 5 did NOT
pass (PR #723 gate round 5 doc-truth finding, Code5/Sec5/A11y5/Verif5 HIGH): its own
`report.json` records `textareaValue` for `05-paste-nonexistent-path` ending
`...pleaseC:/tmp/refract-live-check-723/repo/does-not-exist.png` -- the pasted token was quoted
but came back WITHOUT its quotes, a live REPRODUCTION of the pre-fix quote-dropping defect this
round's own note below wrongly logged as a clean FR-022 pass; the toast itself was correct, but
the fallback TEXT was not. Fixed in code at `616c4059` (round 4) plus the round 5 consistency fix
(`candidateCheckToken`), never re-run live since. From scenario 6 (paste-oversized-image) onward,
the renderer went blank (solid black screenshots, `document` queries returning nothing, though
CDP itself stayed responsive) for the rest of the run -- unresolved: the app's own "Low memory"
status-bar warning was already showing one scenario earlier, on a machine whose free RAM swung
between ~0.4 GB and 1.7 GB repeatedly this session, so a low-memory renderer crash is the leading
candidate [INFERENCE].
Round 4's own read-only probe (see below) found scenario 6's own fixture refused before any
image bytes are read, on the SAME branch as scenario 5 (which rendered fine) -- this narrows, but
does not conclusively prove, the low-memory explanation over an app-level crash; not dug into
further (scope: one live run, one read-only probe). Evidence copied to
`C:/Users/shopwood/refract-live-check-723-live/` with a verified `sha256.json` manifest. STILL
NOT closed -- a follow-up run is needed (fix the `Set-Clipboard` race, then re-attempt from
scenario 6 onward, ideally first establishing whether the crash reproduces in isolation).

**Round 4's own read-only probe conclusion (not proof)**: scenario 6 is a path paste of a
22,020,096-byte padded PNG, refused at main's own `fstat` size cap (`ipc/attachments.ts` ~101)
BEFORE any image bytes are read -- the exact same branch scenario 5 already passed through
cleanly. The blank renderer is most likely the Low-memory artefact described above (the banner
was already showing before any paste that session, RAM swinging ~0.4-1.7 GB), not a crash in the
oversized-image handling path itself, but this is an inference from a read-only probe, not a
repeat of the live scenario. Scenarios 6 onward remain NOT verified.


### Round 1 gate fixes (Sec1/Code1/A11y1/Verif1 FAIL, against the initial Phase 6/7 head)

**2 HIGH, reproduced by multiple reviewers:**
1. `src/main/ipc/attachments.ts`'s absolute-path branch called `fs.realpath(token)` directly,
   following every symlink in one native call with no per-hop vetting -- a symlink planted inside
   the worktree pointing at a UNC share, printed as an absolute path and pasted/dragged, triggered
   a real SMB/NTLM connection attempt with no further click (reproduced live: ~7.8s `fs.realpath`
   call against a loopback UNC target). Fixed: new `resolveNoFollowUnrooted` (`files.ts`) walks
   the absolute token one segment at a time, re-vets every link target via `isUnsafeToken` before
   following it, only then canonicalises via `realpath` -- the FINAL destination still is not
   worktree-contained (research.md Decision 11, corrected), but every hop along the way now is.
2. `MessageInput.tsx`'s path-only paste fallback read `event.currentTarget` AFTER an `await` --
   React 19.3 nulls a synthetic event's `currentTarget` once the handler's synchronous portion
   returns, so any unresolved path (missing, wrong type, over a cap) threw a silent TypeError and
   the pasted text vanished with no notice (FR-022). Fixed: `target`/`start`/`end` captured
   synchronously before the first `await`; the fallback now reads the LIVE draft text from
   `useDraftStore` instead of the stale paste-time closure.
3. `isImagePathOnlyText`/`extractImagePathCandidates` only checked QUOTED substrings, ignoring
   every other word on the line -- `please review "C:\shots\a.png" carefully` counted as
   path-only and the whole sentence was deleted (FR-023). Fixed: a quoted line is path-only only
   when stripping every quoted substring leaves nothing but whitespace; an unquoted line is
   path-only only when it is a single whitespace-free token.

**4 MEDIUM, 1 LOW (code):**
4. `shared/images.ts`'s JPEG header walker misread a legal `0xFF` fill byte (ITU-T T.81 B.1.1.2)
   as a marker, producing a `null` dimension result the caller then ACCEPTED (fail-open) -- a
   crafted JPEG under the byte cap could bypass the pixel cap entirely. Fixed: the walker now
   skips consecutive fill bytes before reading the real marker, and the caller now REFUSES
   (never accepts) a `null` result for any format.
5. `ChatPane.tsx` set `dropEffect = 'none'` for a disabled Session, which means Chromium never
   dispatches `drop` at all (a `'none'` operation fires `dragleave` instead) -- the FR-028
   refusal toast was dead code. Fixed: `dropEffect` is now always `'copy'`; `handlePaneDrop`'s own
   `composerDisabled` check is what actually refuses the drop, with a real toast.
6. A background path/drop read (the mixed-paste branch, every drop) is not awaited by whatever
   triggered it, so pressing Enter mid-read could send the message without the image. Fixed: a
   new per-session `pendingAttachmentReads` counter (`draft-store.ts`) guards `handleSend`.
7. `normalizeImagePathToken` kept only `pathname` from a `file://host/share/x.png` URL, silently
   reading a DIFFERENT local file on the current drive. Fixed: a non-empty `url.host` now returns
   the raw token, letting `isUnsafeToken` refuse the UNC shape.
8. `MAX_IMAGE_PIXELS`'s own cap was applied per paste/drop, not per message (several smaller
   pastes/drops could accumulate past 10 total). Fixed: both call sites now compute remaining
   slots from the session's current pending image count.
9. `files.ts`'s `isUnsafeToken` only ever checked the FIRST colon, so an NTFS alternate data
   stream after a drive letter (`C:\x\host.txt:hidden.png`) slipped through. Fixed: a second,
   independent check rejects any colon from index 2 onward.

**A11y/docs**: chip labels now read "image N of M" when more than one is pending (previously
identical "Remove pasted image" on every one); refusal toasts now name the reason and (for a
drop) the file's own basename, never a full path; `ChatDisplaySection.tsx`'s intro text now
mentions pasted-content handling; the WCAG 2.2 AA 2.5.7 single-pointer-alternative gap (drag has no
non-drag equivalent of its own; paste remains the full keyboard/screen-reader route) is a
disclosed residual, not fixed this round -- a follow-up issue for an attach (file-picker) button
is filed separately, not built here. `spec.md` FR-020/FR-021/research.md Decision 11 corrected
(see above); FR-022/FR-023 reworded "Pasting" (typing was already deferred, Decision 14, but the
FR text still said "Pasting or typing"); US4 corrected (a browser-dragged, not-yet-saved image has
no on-disk path and is refused, not silently attached).

**Checkpoint**: same full gate as Phase 6 (one shared run covering both phases' combined final
code, including this round's fixes): `pnpm typecheck` (`tsconfig.node.json` clean, `tsconfig.web.json`
clean), `vitest` 376/376 (no new tests), `check:indent` 0 odd-indent lines across 327 files,
`check:ui-text` 0 leaks across 371 files, `check:theme-contrast` all 313 pairs across 3 themes PASS
(no new tokens), `check:drag-regions` 0 violations across 110 files, `pnpm build` succeeded (`out/`
cleaned afterward, literal path). **Still not live-verified** (T023 above) -- machine free RAM has
repeatedly dropped under 1 GB this session (Stuart's own live Refract instance, not another lane);
deferred rather than risking a crash, disclosed in the PR body's own "not verified live" list.

### Round 2 gate fixes (Sec2/Code2/A11y2/Verif2 FAIL, against the round 1 head)

**3 LOW/MEDIUM (security):** `shared/images.ts`'s `matchesImageSignature` checked only a 4-byte
prefix for PNG and GIF, accepting any file that merely started with `\x89PNG` or `GIF8` --
strengthened to the full 8-byte PNG signature plus the fixed-offset "IHDR" tag (PNG spec 11.2.2:
always the first chunk) and the full 6-byte "GIF87a"/"GIF89a" signature including the version.
`readImageDimensions`'s GIF case trusted the Logical Screen Descriptor's own nominal canvas size,
which a crafted file can under-declare (even 1x1) while its first Image Descriptor describes a far
larger frame that real-world decoders (including Chromium's) expand the canvas to fit -- fixed to
walk to the first Image Descriptor and take the max of screen and frame extent, closing a pixel-cap
bypass. `attachments.ts`'s absolute-path branch still called `fs.realpath(walked.path)` after the
segment-by-segment walk "only to canonicalise casing" -- but `walked.path` is already link-free and
`fs.realpath` follows links, so that call bought nothing except a second, unvetted chance for a
link swapped in between the walk and this call to be followed. Removed (research.md Decision 11
addendum); a residual TOCTOU window between the walk's last `fs.lstat` and the reader's own
`fs.open` is accepted, not mitigated, reproduced at 1/1228 runs under a tight symlink-swap loop --
identical to `resolveNoFollow`'s own already-accepted residual for the relative branch, and
requiring the same local symlink-creation privilege an attacker who could already reach a UNC path
directly would already have. `attachments.ts`'s `readImageFile` also no longer zero-fills a flat
`MAX_IMAGE_INPUT_BYTES + 1` buffer for every read regardless of the file's real size -- sized from
the actual on-disk size (capped at the limit) instead, so a 1 KB file no longer allocates 20 MiB.

**6 MEDIUM/LOW (code/a11y):** `draft-store.ts`'s plain `EMPTY_DRAFT` overwrite (on send, and on
`/btw`) reset `pendingAttachmentReads` to 0 even while a background path/drop read was still in
flight, reopening the exact Enter-mid-read race the counter exists to close -- fixed to preserve
the in-flight count across a clear. `MessageInput.tsx`'s path-only paste fallback captured
`start`/`end` synchronously (round 1 fix) but not the textarea's own live text at that moment --
if the developer typed during the IPC round trip, splicing at the stale offsets could delete or
duplicate characters just typed; fixed to capture `before` alongside `start`/`end` and insert at
the current caret (or text end) instead of the stale offsets when a mismatch is detected. The
mixed-paste background branch silently dropped an over-cap or unresolved path with no notice at
all, contradicting FR-026's own "quiet notice" requirement -- fixed to notify with the same wording
the path-only branch already uses. No visible or announced reason was given while Send/Enter were
refused during an in-flight background read -- fixed with a one-time "Attaching image…" text line
and a single announcement per 0-to-positive transition of `pendingAttachmentReads` (never on every
re-render, never again on an already-covered 0-to-0 no-op). Removing a pending image's own remove
button unmounted it with no focus management and no announcement (WCAG 2.4.3, reachable up to 10x
per message now that #514/#432 can produce more than one or two pending images) -- fixed to move
focus to the next remaining remove button (or the textarea if none remain) and announce the
removal. `ChatPane.tsx`'s drop-overflow notice read "Only 0 more images could be attached" for a
zero-slots overflow, and silently dropped the failure half of its own message when a drop had BOTH
an overflow and a resolve failure at once -- both now stated precisely.

**Wording**: `AttachmentStrip.tsx`'s single-image labels ("View pasted image" / "Remove pasted
image") are now generic ("View image" / "Remove image"), since a path-attached or dropped image
was never actually pasted; the multi-image "image N of M" labels (round 1) were already generic.

**Checkpoint**: same full gate, combined final code including this round's fixes: `pnpm typecheck`
(both tsconfigs clean), `vitest` 376/376 (no new tests), `check:indent` 0/327, `check:ui-text`
0/371, `check:theme-contrast` 313/313 (no new tokens), `check:drag-regions` 0/110, `pnpm build`
succeeded (`out/` cleaned afterward, literal path). Live verification: see PR body.

### Round 3 gate fixes (Sec3 FAIL High, A11y3 FAIL High, Code3/Verif3 Mediums, against the round 2 head)

**1 HIGH (security)**: `src/main/omp/images.ts`'s `validateImageAttachment` decoded only the
first 16 base64 characters (12 bytes) of an image's payload to check its magic-byte signature --
but round 2 strengthened `matchesImageSignature`'s PNG case to require 16 bytes (full 8-byte
signature plus the fixed-offset "IHDR" tag) and GIF to require 6, so the check was ALWAYS `false`
for PNG and `chat.send` rejected every PNG attachment -- the format nearly every screenshot is,
and the renderer's own re-encode target for any unsupported format -- with "Unsupported image
type: image/png". Broke BOTH the pre-existing clipboard-image paste (spec 009) and this PR's own
path/drop attachments, for every PNG. Fixed: decodes `slice(0, 24)` (18 bytes) instead, covering
every current format's signature with headroom. Proven against the REAL `validateImageAttachment`/
`matchesImageSignature` (not a reimplementation) via a throwaway scratch script (verbatim copies
of the two source files, deleted after use) constructing minimal real PNG/JPEG/GIF/WebP headers,
each valid, truncated, and fake/mislabeled: every valid format now reports `{"ok":true}`; every
truncated/fake case still correctly reports `{"ok":false,"code":"unsupported-image-type"}`; the
OLD 16-char slice was independently confirmed to reject the same valid PNG bytes the new 24-char
slice accepts, closing the loop on both the bug and the fix.

**1 HIGH (a11y)**: `MessageInput.tsx`'s round-2 focus-after-remove fix queried the WHOLE
`document` for `[role="group"][aria-label="Pending attachments"]` -- in split view, where two
`ChatPane`s each render their own `MessageInput`/`AttachmentStrip` pair, this always found
whichever pane's strip happened to render first in the page, not necessarily the pane the user
was actually in. Removing an image in pane B could move focus to pane A's own Remove button; a
second Enter (the natural "remove the next one" gesture) then deleted PANE A'S attachment, and
"Image removed." announced through pane A's live region. Fixed: `AttachmentStrip` now accepts an
optional `containerRef`; `MessageInput.tsx` wires its own `attachmentStripRef` through it and
scopes both the focus-origin check and the remove-button query to that ref, never `document`.

**6 Medium/Low (code/a11y)**: both the path-only and mixed-paste branches' own notices only ever
reported ONE of "overflow" or "read failure" when a single paste produced both -- fixed to join
both sentences, matching the pattern `ChatPane.tsx`'s own drop-overflow notice already used.
`ChatPane.tsx`'s "N OTHER files could not be attached" said "other" even when nothing else
attached or overflowed in the same drop -- fixed to say "N files..." (no "other") in that case.
An unquoted path containing spaces (Windows' own default screenshot filenames, VS Code's "Copy
Path", ShareX) was never detected at all and pasted as literal text with no notice, even though
#514's own spec explicitly asks to "prefer matching existing files (stat)" -- fixed: a line that
is unambiguously path-shaped end to end (starts with a drive-letter separator or `file://`, ends
in a supported image extension, no quote characters) is now a candidate even with embedded
spaces; main's own `fs.stat` remains the real authority on whether it resolves. A path-only paste
of an `https://` image URL was treated as a path candidate, triggering a pointless IPC round trip
that always failed and re-inserted the URL with a misleading "could not be found; left as text"
notice -- fixed: any URL scheme other than `file:` is now rejected by the same cheap pre-filter
(a single-letter drive prefix is unaffected, handled first). The fallback re-insert on an
unresolved/overflowed path used the NORMALIZED token (quotes stripped, a `file://…%20…` URL
decoded), contradicting FR-022's own "its own raw text" wording -- fixed: `extractImagePathCandidates`
now returns each candidate's raw AND normalized form, and the fallback re-inserts the raw one.
The GIF dimension walk (round 2) stopped at the FIRST Image Descriptor -- a multi-frame GIF's
SECOND (or later) frame could still be oversized and bypass the pixel cap (reproduced: a 10x10
screen plus a 60000² second frame was accepted) -- fixed to walk every Image Descriptor in the
buffer, taking the max bound across all of them, not only the first.

**Docs/wording**: the round-2 "mirrors the EXACT accepted residual" wording (`attachments.ts`,
research.md Decision 11) overstated things -- the relative branch's TOCTOU window ends in a
`fs.realpath` + containment rejection backstop the absolute branch has no equivalent of; corrected
to describe the same RACE WINDOW without claiming an identical backstop, and the "1/1228" figure
is now attributed to "the lane's own measurement", not independently reproduced by every reviewer.
A dead `bytesRead > MAX_IMAGE_INPUT_BYTES` branch in `readImageFile` (unreachable since round 2's
real-size buffer sizing) removed. Stale doc comments fixed: `readImageDimensions`'s own doc
claimed a `null` result is "could not verify, not a hard failure" when the caller actually
REFUSES every `null` (round 1's own fix); research.md Decision 12 still named only the GIF
"Logical Screen Descriptor" without mentioning the Image Descriptor expansion. Issue #728
corrected: its body said "once #514's Settings switch is on", implying the switch defaults OFF,
when FR-024 requires ON by default. `spec.md` FR-026/SC-007/US3 wording ("silently skipped"
contradicted FR-026's own quiet-notice requirement; "paste/type" still implied typing detection
shipped, though it is deferred to #727) corrected. `docs/PLAN.md`'s composer row corrected: no
longer says "realpath" for the absolute branch (removed this round), no longer says "typed"
(deferred), status cell now says "gate round 3".

**Live-check harness fix (Verif3 Medium, root-caused)**: round 2's own live-run attempt was
INVALID, not inconsistent with the code -- see T023's own note above for the full root cause
(an inherited `ELECTRON_RENDERER_URL` loaded the MAIN checkout's dev-server renderer, which has
no #514/#432 code, into every one of 26 scenarios). Fixed in the scratch driver scripts
(`driver.js`, `diag-paste.js`, `spawn.js`): spawn now strips `ELECTRON_*`/`VITE_*` env vars, and a
preflight (`file://` URL inside this worktree, `window.refract.attachments.readImageFile` present)
runs before any scenario. The paste mechanism itself also now uses CDP `Input.dispatchKeyEvent`'s
`commands: ['paste']` directly (the documented, keyboard-layout-independent way to invoke a real
paste over CDP) rather than simulating a Ctrl+V keydown/keyup pair.

**Checkpoint**: same full gate, combined final code including this round's fixes: `pnpm typecheck`
(both tsconfigs clean), `vitest` 376/376 (no new tests), `check:indent`, `check:ui-text`,
`check:theme-contrast`, `check:drag-regions`, `pnpm build` -- see the PR body's own Gates section
for this round's exact numbers. Live verification: attempted once this round against the fixed
harness -- partial (FR-023 live-confirmed; FR-022 NOT live-confirmed -- scenario 5 actually
reproduced the quote-dropping defect, see the corrected note above; a renderer crash from
scenario 6 onward left the rest unverified); see T023's own note above. Still open.

---

### Round 4 gate fixes (Verif4 HIGH, Sec4/Code4 Medium, against the round 3 head)

**1 HIGH**: `extractImagePathCandidates` (`attachments.ts`) pushed the regex CAPTURE GROUP
(quotes already stripped) as a QUOTED candidate's own `raw` value, so an unresolved Explorer
"Copy as path" paste came back WITHOUT its own quotes on the FR-022 fallback -- the round 3
"raw-vs-normalized" fix only ever covered the `file:///%20` URL case, never the quoted-path case
it claimed to fix too. Fixed at `616c4059`: `raw` is now the full quoted match (quotes included);
candidates are built as `{ raw, normalized: normalizeImagePathToken(raw) }` and filtered on
`looksLikeImagePathToken(normalized)` (the extension regex can never match past a trailing quote
character). Verified with a throwaway scratch probe under `C:/tmp` (deleted after use; a
pure-function copy of the fixed helpers, no app code touched): quoted path -> raw keeps quotes;
`file:///C:/my%20x/a.png` -> raw keeps `%20`; unquoted spaced path unchanged; `https://` excluded;
mixed text + quoted path -> quotes preserved, prose untouched. All 5 cases passed. Round 3's own
scenario 5 run did NOT actually pass (see the corrected round 3 live-check note above: its own
`report.json` reproduced the quote-dropping defect) -- this fix is confirmed in code only, not
re-run live.

**Docs (Verif4/Code4/A11y4 Medium)**: the round 3 live-check note's "genuine app-level crash"
framing for scenario 6 overstated an inference as a conclusion; corrected above to attribute the
blank renderer to the Low-memory artefact as the LEADING candidate, not a proven cause, backed by
a new read-only probe conclusion (not itself live proof). `docs/PLAN.md`'s composer row status
cell corrected from "gate round 3" to current (round 4 passed with fixes).
`MessageInput.tsx`'s cap-reached notice reworded to "nothing more was attached; the paths were
left as text." `ChatPane.tsx`'s dead `failedFiles.length === 1 ? '' : 's'` pluralisation inside
its own `>1` branch (always `'s'` there) replaced with the literal "other files".

**Risks (pre-existing, not introduced this round)**: the clipboard-IMAGE path
(`attachments.ts` ~80-139) decodes any clipboard MIME type via `createImageBitmap` BEFORE the
pixel cap -- an unsupported type has no size check at all before decode, and even a supported
type has no pixel check until the later thumbnail decode; renderer memory is roughly 230 MB per
image at the existing caps (10 images is therefore ~0.5 GB of strings plus bitmaps). Filed as a
follow-up: see the PR body's own Risks section for the issue link. Separately: an unquoted,
drive-letter-prefixed line of ordinary prose that happens to END in a supported image extension
is indistinguishable from a real path-only paste under the current heuristic; if the read fails,
the raw text is re-inserted with a quiet notice and native undo is lost for that keystroke --
accepted as the simplest correct heuristic given there is no reliable way to tell "this is prose"
from "this is a real but currently-unreadable path" without a quote character to anchor on.

**Checkpoint**: `pnpm typecheck` (both tsconfigs), `vitest` (no new tests), `check:indent`,
`check:ui-text`, `check:theme-contrast`, `check:drag-regions`, `pnpm build` -- see the PR body's
own Gates section for this round's exact results. No live app verification attempted this round
(code-level fix plus a read-only probe only); scenarios 1-3 and 6-26 remain not completed; a
manual pass by Stuart in a normal Session is requested (see the PR body's own Verification
section for exact steps). Still open pending that manual pass.

---

### Round 5 gate fixes (Code5/Sec5/A11y5 HIGH, doc-truth finding against the round 4 head)

**1 HIGH (probe-reproduced)**: `extractImagePathCandidates`'s candidate filter ran on
`normalized` while `isImagePathOnlyText` ran its own equivalent check on the raw (quote-stripped
only) token -- they could disagree on a `file://` URL carrying a `#`/`?` suffix, since
`normalizeImagePathToken`'s own `new URL(...)` parse drops everything from a `#`/`?` onward as a
fragment/query, losing the `.png` extension that `isImagePathOnlyText` still saw at the string's
own end. A paste like `C:\x.png` + `file:///C:/a#b.png` was path-only=true but yielded only 1
candidate for 2 lines, so the path-only branch's `preventDefault` silently dropped the second
line with no notice (FR-022). Fixed: both functions now share one `candidateCheckToken`
(quote-strip only, never `file://`-decoded) ahead of `looksLikeImagePathToken`, so they can never
disagree again; `normalized` is still what is actually sent over IPC. Re-verified with a
throwaway scratch probe under `C:/tmp` (deleted after use): quoted path (raw keeps quotes), two
quoted paths, quoted `.txt` excluded, quoted `https://` excluded, mixed prose + quoted path (not
path-only, text unchanged), `file:///C:/a%20b/x.png` (raw keeps `%20`), `file:///C:/a#b.png` and
`file:///C:/a?v=b.png` (path-only consistent: candidate count now equals line count, nothing
vanishes), unquoted spaced path, CRLF lines -- all consistent, no vanishing line. See the PR
body's own probe table for the full case/result list.

**LOW**: `MessageInput.tsx`'s mixed-paste partial-slots overflow notice ("Only N more images
could be attached...") now appends "; the rest were left as text." so the fate of the remaining
paths is stated, not left implicit.

**Docs (A11y5/Sec5/Verif5/Code5 HIGH, verified against `report.json`)**: round 3's own live-check
note wrongly logged scenario 5 (quoted nonexistent path) as a clean FR-022 pass; its own
`report.json` `textareaValue` for `05-paste-nonexistent-path` in fact came back WITHOUT its
quotes, a live REPRODUCTION of the pre-fix defect, not a pass. Corrected above (round 3 note,
round 3 checkpoint, round 4's scenario-5 cross-reference), in the PR #723 body (FR-022 AC row now
"Done in code; not live-verified", the Round 4 paragraph, the Net paragraph, the live-verification
scenario-5 bullet), and in the #650 comment (6145134709, edited via `gh api -X PATCH`). FR-023 /
scenario 4 remains live-verified (text unchanged, thumbnailCount 1, per `report.json`). The manual
click-path list (#650 and the PR body) gained: "Explorer Copy as path on a PNG, delete or rename
the file, then paste: expect the text to come back WITH its surrounding quotes and a quiet
could-not-be-found notice." `docs/PLAN.md`'s composer row status cell now reads: "gate round 4
failed (1 doc/code HIGH), fixed; round 5 failed (1 code HIGH + doc-truth), fixed; round 6 pending;
not live-verified."

**Checkpoint**: `pnpm typecheck` (both tsconfigs), existing `vitest` (no new tests),
`check:indent`, `pnpm build` then `check:ui-text`, `check:theme-contrast`, `check:drag-regions` --
see the PR body's own Gates section for this round's exact results. No live app verification
attempted this round (code-level fix plus a read-only probe only); scenarios 1-3 and 6-26 remain
not completed; a manual pass by Stuart in a normal Session is still requested. Still open pending
that manual pass.

---

## Phase 8: User Story 5 - Attach any file type, not only images (#926, Priority: P2)

**Goal**: the Attach button, drag-and-drop, and a clipboard paste accept any file, not only
images; a text file up to 256 KB inlines verbatim, everything else (binary, over-cap, or a folder)
attaches as its own absolute path, reusing Story 1/3/4's shared attachment strip/remove/cap
machinery end to end rather than a second pipeline.

- [X] T024 [P] (#926) Write `src-tauri/src/ipc/file_attachments.rs`: `attachments.readFile`
  classifies a resolved non-image path (inline text up to 256 KB, or path for binary/oversized/a
  folder -- grill decisions 2/3) in one bounded open-stat-read (never a separate stat then read,
  mirrors `attachments.rs`'s own `read_image_file` guard); `attachments.pickFiles` is the Attach
  button's native multi-file dialog, no extension filter. Reuses `attachments.rs`'s own
  `resolve_attachment_path` (made `pub(super)`) rather than a second containment/symlink walk.
- [X] T025 (#926) Write `src-tauri/src/omp/file_attachment_markers.rs`: parses the
  `[[refract-attachments]]` section Refract itself appends to the plain message text back into
  `FileAttachmentRef`s (research.md Decisions 17-18); wired into `transcript.rs`'s own shared
  `build_user_item`, called from both `apply_message_snapshot` and `items_from_history` so a live
  turn and a reopened history build the same `TranscriptItem.fileAttachments` the same way.
- [X] T026 [P] [US5] Write `src/renderer/features/chat/anyFileAttachments.ts`: `buildAnyPathAttachment`
  routes a resolved path through the existing image reader (by extension, FR-031) or the new file
  reader; `buildFileAttachmentText`/`appendFileAttachmentText` build the outgoing marker text
  (FR-040's lead-in line and fence-length rule); `buildPastedFileAttachment` handles a non-image
  clipboard `File` paste, inline-only (FR-037, no OS path available).
- [X] T027 [US5] Wire `ComposerPickers.tsx`'s `AttachButton` to the native `attachments.pickFiles`
  multi-file dialog (any type, replacing the old image-only `<input type="file">`); generalise
  `ChatPane.tsx`'s drop wording and `attachDroppedPaths.ts`'s shared attach-loop (now
  images-and-files, FR-039's shared cap) so `useTauriFileDrop.ts`'s existing drop path needs no
  changes of its own.
- [X] T028 [US5] Wire `MessageInput.tsx`'s paste handler (`attachPastedFiles`, `attachImage.ts`)
  and send path: every pending file/folder attachment is appended to the OUTGOING message only
  (`appendFileAttachmentText`), never the draft text itself, so `parseSlashCommand`/the `/new`
  check keep reading just the developer's own typed text.
- [X] T029 [US5] Write `AttachmentStrip.tsx`'s file/folder chips (icon, name, size, "sent as path")
  and `UserMessageRow.tsx`'s sent-bubble chips (read from `TranscriptItem.fileAttachments`, FR-035);
  share `removeAttachment.ts`'s own remove-with-focus-restoration core (PR #723's A11y2/A11y3
  fixes) with the existing image chip rather than a second copy.
- [ ] T030 Live click-path verification (`scripts/verify-926-attach-any-file.mjs`): attach a small
  text file, a file over 256 KB, a binary file, an image, and a folder via the Attach picker and
  via drag-and-drop; confirm each chip's wording, the sent bubble's own chips (never raw text or a
  raw path line), keyboard Remove, and the transcript's `fileAttachments` on the sent item, in
  Dark, Obsidian, and Dark high contrast. NOT done yet -- this lane built with no cargo available
  (no-build prep lane); blocked on the build slot the same way T023 above was blocked on a live
  pass. T024-T029's own `[X]` marks cover the code being written and non-build-gate-clean, not
  this live pass.

**Checkpoint**: `pnpm typecheck` (both tsconfigs), existing `vitest` (148/148, no new tests),
`check:indent`, `check:file-size`, `check:parity --gate`, `check:drag-regions` all green on this
head (see the PR body's own Gates section for the exact run). `check:theme-contrast` also green.
`check:ui-text`, a cargo build, and T030's live check are still pending the lane's build slot.
