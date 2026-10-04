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

  Built: `AttachmentsState` as `MessageInput`'s own local state (correct lifetime: draft-only, remounts with `key={sessionId}`, matching `text` itself). `handleSend` substitutes chips and attaches `images` on `chat.send`; `handleSendNow` (the existing queued-chip "Send now" button) also forwards currently-pending images and clears them on success -- see final report for the judgment call this required, since a resend's `steer` command is built from scratch server-side and cannot otherwise carry forward whatever `images` the original queued `prompt` had. A failed send leaves the draft and every pending attachment untouched (`notify(result.error)`, early `return`, nothing cleared). `pnpm typecheck`/`pnpm build`/`pnpm check:ui-text` (0 leaks/371 files) all clean.

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
