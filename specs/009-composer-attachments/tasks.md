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

- [ ] T001 (#364) [P] Add shared types and constants: `ImageContent` and `SupportedImageMimeType` in
  `src/shared/frames.ts`, `images?: ImageContent[]` added to `PromptCommand` and `SteerCommand` only
  (no other `RpcCommand` variant changes — research.md Decision 5); new `src/shared/images.ts`
  exporting `SUPPORTED_IMAGE_MIME_TYPES`, `MAX_IMAGE_INPUT_BYTES` (20 MiB), and
  `LARGE_PASTE_CHIP_THRESHOLD` (800), per data-model.md "Shared wire type" and "Shared constants".

**Checkpoint**: `pnpm typecheck` passes with the new, as-yet-unused types and constants.

---

## Phase 2: Foundational (blocks both stories)

**Purpose**: the main-process validation and RPC passthrough, and the IPC surface, that both
stories' sends go through.

- [ ] T002 (#365) Write main-process image validation and RPC passthrough: `src/main/omp/images.ts`
  exporting `validateImageAttachment(image: ImageContent): { ok: true } | { ok: false; code:
  'unsupported-image-type' | 'image-too-large' }` (mime type checked against
  `SUPPORTED_IMAGE_MIME_TYPES`, decoded byte length — from the base64 string's own length, not a
  live network download — checked against `MAX_IMAGE_INPUT_BYTES`); extend `SessionAgent.send` and
  the steer path in `src/main/omp/SessionAgent.ts` to accept an optional `images` argument and
  forward it unchanged onto the `prompt`/`steer` command each builds, never altering the
  renderer-prepared base64 or mime type (depends on T001).
- [ ] T003 (#366) Wire `images` through the IPC surface: `src/shared/ipc.ts` (`chat.send(sessionId, text,
  images?)`, `chat.sendNow(sessionId, text, images?)`, the two new error codes
  `unsupported-image-type`/`image-too-large` per contracts/ipc.md), `src/main/ipc/chat.ts`'s
  `CHAT_SEND`/`CHAT_SEND_NOW` handlers (call `validateImageAttachment` on every entry before ever
  calling `SessionAgent`, the same place the existing `sessionId`/argument-shape checks already run,
  returning the matching error code on the first failing entry and sending nothing), and
  `src/preload/index.ts` (expose the new parameter on both exposed methods) (depends on T002).

**Checkpoint**: a scratch script can call `chat.send` with a hand-built base64 PNG under the cap and
observe `images` set on the `prompt` command `OmpProcess` actually sends; an oversized or
wrong-mime-type payload is rejected with the matching error code before any RPC command is built.
`pnpm typecheck` passes.

---

## Phase 3: User Story 1 - Attach a pasted image to the next message (Priority: P1) 🎯 MVP

**Goal**: paste an image, see a thumbnail, view it full-size in a modal, send it to the agent as a
real image attachment.

**Independent Test**: [quickstart.md](quickstart.md) Story 1.

- [ ] T004 (#367) [P] [US1] Write paste capture, size/format validation, and PNG re-encode in the renderer:
  extend `MessageInput.tsx`'s paste handler to read `ClipboardEvent.clipboardData.items`, extract an
  image item's `Blob` via `item.getAsFile()`, read it to base64, re-encode a non-PNG/JPEG/GIF/WebP
  blob to PNG via an off-screen `<canvas>` (`createImageBitmap` + `canvas.toBlob('image/png')`)
  before it becomes a pending attachment, and check the result against the shared
  `MAX_IMAGE_INPUT_BYTES` constant from `src/shared/images.ts`, rejecting an over-cap paste with an
  inline message naming the limit and creating no pending attachment (FR-001 to FR-003; research.md
  Decision 7) (depends on T001).
- [ ] T005 (#368) [P] [US1] Write the attachment strip and image preview UI: new
  `src/renderer/features/chat/AttachmentStrip.tsx` (renders every pending
  `PendingImageAttachment`'s thumbnail and every pending `PendingTextChip`'s label-overlay chip in
  one shared row, sized per research.md Decision 9: a compact row for a small thumbnail, a taller
  preview block when one needs more room; hidden entirely when nothing is pending — FR-009), each
  thumbnail's own remove control (FR-005), and new
  `src/renderer/features/chat/ImagePreviewModal.tsx` (shadcn `Dialog`, full-size image, Esc or
  outside-click closes and returns focus to the thumbnail — FR-004, FR-016) (depends on T001).
- [ ] T006 (#369) [US1] Wire pending images into send: add an `AttachmentsState` slice
  (data-model.md) to the renderer's existing chat state alongside the draft/queue state; make
  `handleSend` (both the idle `chat.send` path and the queued `chat.sendNow` path, FR-017) include
  every pending `PendingImageAttachment` as an `ImageContent[]` on the call; clear pending image
  attachments once that call resolves successfully (FR-006, FR-007); surface an
  `unsupported-image-type`/`image-too-large`/`prompt-failed` error inline, leaving the draft and
  remaining attachments intact rather than discarding them (FR-019) (depends on T003, T004, T005).

**Checkpoint**: run quickstart Story 1 in full. `pnpm typecheck` and `pnpm build` pass.

- [ ] T007 (#370) [US1] Update the docs and verify live: `docs/DESIGN.md` Chat section (the attachment
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

---

## Phase 4: User Story 2 - Collapse a large pasted block of text into a chip (Priority: P2)

**Goal**: paste a large block of text, see it collapse into a clickable chip in place, view the full
text in a modal, send the exact original text to the agent.

**Independent Test**: [quickstart.md](quickstart.md) Story 2.

- [ ] T008 (#371) [P] [US2] Write large-paste detection and placeholder-label insertion: extend
  `MessageInput.tsx`'s paste handler (added alongside T004's image path, same paste-event entry
  point: an image representation always wins when present, Edge Cases) to measure a plain-text
  paste's length against `LARGE_PASTE_CHIP_THRESHOLD`; over it, insert a short literal label (first
  line truncated, plus a character count, plus a disambiguating index when two pending chips would
  otherwise collide — data-model.md `PendingTextChip.label`) into the textarea's own value at the
  paste position instead of the raw text, and create a matching `PendingTextChip` entry holding the
  full original text (FR-010, FR-011, FR-015) (depends on T001).
- [ ] T009 (#372) [P] [US2] Write the chip's clickable overlay and its modal: reuse
  `MessageInput.tsx`'s existing ghost-text overlay text-metrics measurement (spec 001 T103, FR-058;
  research.md Decision 10) to render a clickable, chip-styled overlay exactly over each pending
  chip's `label` at its current rendered position in the textarea, opening new
  `src/renderer/features/chat/TextPreviewModal.tsx` (shadcn `Dialog`, full original text, read-only,
  selectable, scrollable — FR-012) on click; on every draft change, drop any pending chip whose
  `label` no longer appears intact in the textarea's value (an edit or an ordinary delete both count
  — FR-014, Edge Cases) (depends on T005, T008).
- [ ] T010 (#373) [US2] Wire chip substitution into send: before `handleSend` calls `chat.send`/
  `chat.sendNow`, replace every still-pending chip's `label` occurrence in the draft with its full
  `text`, producing the exact plain string sent as `message` (FR-013); multiple pending chips each
  substitute independently at their own position (FR-015); no `images` entry is added for this half
  (research.md Decision 6) (depends on T006, T009).

**Checkpoint**: run quickstart Story 2 in full. `pnpm typecheck` and `pnpm build` pass.

- [ ] T011 (#374) [US2] Update the docs and verify live: `docs/DESIGN.md` Chat section (the 800-character
  chip threshold, the placeholder-label-plus-overlay technique and why it exists given a plain
  textarea, the text-preview modal); then on the built app in an isolated instance: paste a short
  snippet under the threshold and confirm it still lands as plain text exactly as before; paste a
  long code block over the threshold and confirm it collapses to a labelled chip instead of flooding
  the textarea; click the chip and confirm the modal shows the exact original text; send the message
  and confirm (via a temporary log of the exact `message` string handed to `OmpProcess`) the full
  original text was substituted back, not the label; delete the chip's label by hand and confirm it
  silently drops from pending state with no error; paste two oversized blocks in one draft and
  confirm both substitute back correctly and independently (depends on T010).

---

## Phase 5: Polish

- [ ] T012 (#375) Accessibility pass: on the built app in an isolated instance, confirm every control this
  spec adds (a thumbnail, its remove control, a text-chip overlay, both modals' close controls) has
  an accessible name, a visible focus indicator, and is reachable and operable using only the
  keyboard (Tab/Shift+Tab to reach it, Enter/Space to activate it, Esc to close a modal); confirm no
  state here (pending vs. attached, which format was re-encoded) is conveyed by colour alone (FR-016;
  constitution, spec 001's square-corner/baseline accessibility rules) (depends on T007, T011).
- [ ] T013 (#376) Final full quickstart run across both stories: `pnpm typecheck` and `pnpm build` pass; run
  quickstart.md's full Story 1 and Story 2 checklists back-to-back in one scratch Session, confirming
  neither story regressed the other (an image pending alongside a text chip in the same draft sends
  both correctly) (depends on T012).

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
