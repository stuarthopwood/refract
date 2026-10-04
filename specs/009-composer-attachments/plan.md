# Implementation Plan: Composer attachments

**Branch**: `009-composer-attachments` | **Date**: 2026-10-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/009-composer-attachments/spec.md`

## Summary

Add two attachment kinds to the message composer. Pasting an image creates a pending image
attachment shown as a thumbnail in a shared attachment strip above the message box; clicking it
opens a modal with the full image; sending the message includes it as a real `ImageContent` entry
on OMP's existing `images` field of the `prompt`/`steer` command, so the agent actually receives it.
Pasting a block of plain text over 800 characters collapses it into a labelled chip sitting in place
in the draft (reusing the existing ghost-text overlay technique); sending substitutes the chip's
full original text back into the plain `message` string at its own position, exactly as if it had
been typed there, using no new OMP capability. Design rationale is in [research.md](research.md);
the one changed interface contract is in [contracts/](contracts/).

## Technical Context

**Language/Version**: TypeScript (`strict: true`) on Node 24.21.0 as bundled by Electron 44.5.1;
React 19.3.0 in the renderer. Same stack as spec 001; no version change.

**Primary Dependencies**: no new npm dependency. Uses the Web Platform `ClipboardEvent`/
`DataTransferItem` paste APIs and the Canvas 2D / `createImageBitmap` APIs already available in
Refract's existing sandboxed renderer (research.md Decision 7), and the already-installed shadcn
`Dialog` primitive (`src/renderer/components/ui/dialog.tsx`, used today by `NewSessionDialog.tsx`)
for both the image-preview and text-preview modals. No new UI primitive is added.

**Storage**: none. Every entity this spec introduces (`PendingImageAttachment`, `PendingTextChip`,
`AttachmentsState`) lives only in renderer memory for the draft currently being composed
(data-model.md); nothing is written to `registry.json`, `settings.json`, or any new file.

**Testing**: none. Refract is a prototype (constitution, Development Workflow); each story is
verified by running the app per [quickstart.md](quickstart.md). `pnpm typecheck` and `pnpm build`
must pass before a change lands on `main`.

**Target Platform**: Windows 11 only.

**Project Type**: desktop-app (Electron: main, preload, renderer) — same project as spec 001, no new
source root.

**Performance Goals**: from the spec: a non-vision model's extra vision-description admission delay
(up to 20 s, OMP's own cap) never surfaces as an error (FR-008, SC-005); every click on a pending
thumbnail or chip opens its modal immediately (SC-004); re-encoding a pasted image to PNG and
measuring its decoded size happens synchronously enough that pasting does not visibly stall typing.

**Constraints**: a pending image over 20 MiB (`MAX_IMAGE_INPUT_BYTES`, OMP's own cap) is rejected
before it is ever sent (FR-003); only `image/png`, `image/jpeg`, `image/gif`, `image/webp` are ever
sent, anything else re-encoded to PNG first (FR-002); the renderer is sandboxed and untrusted for
the privileged send path, so the main process independently re-validates both the mime type and the
decoded size before building any outgoing command (FR-018, constitution Principle V).

**Scale/Scope**: one developer; typically one or two pending attachments per message, occasionally a
handful; 19 requirements across 2 user stories.

## Constitution Check

*GATE: passes before Phase 0; re-checked after Phase 1 design. Constitution v1.7.1.*

| Principle | Status | How the design meets it |
|---|---|---|
| I. OMP is the engine | Pass | Adds no new launch mode, flag, or SDK/ACP path. The `images` field is part of the `prompt`/`steer` commands Refract already sends over its existing `omp --mode rpc-ui` process; the large-text-chip half sends the same plain `message` string Refract always has. |
| II. RPC wire contract | Pass | `images` rides the existing `message`-carrying commands (`prompt`, `steer`); no literal `/btw`; the extra vision-description admission delay is tolerated per its documented behaviour (research.md Decision 4), not misread as a stuck turn; no new dialog or frame type is introduced. |
| III. Session and process lifecycle | Pass | No change to how a Session's agent is started, reattached, or killed; attachments are composer-only state that exists before a command is ever sent, with no bearing on process lifecycle. |
| IV. Evidence before design | Pass, no new gate needed | Every OMP wire-level fact this design relies on (the `images` field, `ImageContent`'s shape, the 20 MiB cap, the four supported mime types, the vision-description admission delay) was read directly from OMP's own `rpc.md` and source this session, not assumed (research.md Decisions 1 to 4); Refract's own current `frames.ts` was read to confirm it has neither the field nor the type yet, and that only `PromptCommand`/`SteerCommand` need it (research.md Decision 5). No first-task probe is scheduled for the RPC wire shape itself; the two genuinely new, spec-owned numbers (the chip threshold, the strip's sizing) are plain defaults recorded as Decisions, not facts needing a probe. |
| V. Electron security baseline | Pass | The renderer never gains a new privileged capability: it reads a clipboard paste through standard, already-sandboxed Web Platform APIs (research.md Decision 7) and sends only validated base64 + mime type over the existing `contextBridge` channel. The main process independently re-validates both the mime type and the decoded size before any image reaches an outgoing RPC command (FR-018), never trusting the renderer's own check alone. |
| Platform and Stack | Pass | Windows 11 only; no new source root; no new npm dependency. |
| Development Workflow | Pass | Spec Kit order; no automated tests; typecheck and build gate; each story verified by running the built app. |

No violations, so the Complexity Tracking table is empty.

## Project Structure

### Documentation (this feature)

```text
specs/009-composer-attachments/
├── spec.md
├── plan.md              # this file
├── research.md          # decisions and the OMP facts they are grounded against
├── data-model.md         # ImageContent, PendingImageAttachment, PendingTextChip, AttachmentsState
├── quickstart.md         # how to run and verify each story
├── contracts/
│   └── ipc.md            # the images? addition to chat.send/chat.sendNow (spec 001's base contract)
├── checklists/requirements.md
└── tasks.md              # produced by /speckit.tasks
```

No `contracts/omp-usage.md`: this spec introduces no new frame type and no new dialog
classification (contracts/ipc.md, "Unaffected surfaces").

### Source code (repository root, additions only — spec 001's tree is unchanged elsewhere)

```text
src/
├── shared/
│   ├── frames.ts                   # + ImageContent, images? on PromptCommand/SteerCommand (data-model.md)
│   ├── images.ts                   # + SUPPORTED_IMAGE_MIME_TYPES, MAX_IMAGE_INPUT_BYTES,
│   │                                #   LARGE_PASTE_CHIP_THRESHOLD (data-model.md)
│   └── ipc.ts                      # + images? on chat.send/chat.sendNow, two new error codes (contracts/ipc.md)
├── main/
│   ├── omp/
│   │   ├── images.ts               # + validateImageAttachment(images): mime + size re-check (research.md 3)
│   │   └── SessionAgent.ts         # send()/sendNow() forward images unchanged onto prompt/steer
│   └── ipc/
│       └── chat.ts                 # CHAT_SEND/CHAT_SEND_NOW handlers validate images before SessionAgent
├── preload/
│   └── index.ts                    # + images? parameter on the exposed chat.send/chat.sendNow
└── renderer/
    ├── state/
    │   └── (existing chat state)   # + AttachmentsState slice per Session (data-model.md)
    └── features/
        └── chat/
            ├── MessageInput.tsx     # paste handler: image capture/re-encode, large-paste chip detection,
            │                        #   ghost-text-overlay reuse for chip labels (research.md 7, 10)
            ├── AttachmentStrip.tsx  # new: pending image thumbnails + text chips, remove controls (FR-009)
            ├── ImagePreviewModal.tsx # new: shadcn Dialog, full-size image (FR-004)
            └── TextPreviewModal.tsx  # new: shadcn Dialog, full original text, read-only (FR-012)
```

**Structure Decision**: same one-project Electron layout as spec 001 (`main`, `preload`, `renderer`,
`shared`); this spec adds one new main-process file (`src/main/omp/images.ts`), one new shared file
(`src/shared/images.ts`), and three new renderer components under the existing `chat/` feature
folder. No new source root, no new npm dependency, no new IPC area (the two changed methods already
live in `src/main/ipc/chat.ts`).

## Design overview

- **Images are a wire-level attachment from the start, never a local-only decoration.** The
  thumbnail the developer sees is the same base64 + mime type that ends up in the `images` field of
  the command Refract sends; there is no separate "upload" step and no intermediate representation
  that could drift from what is actually sent (FR-006).
- **Validate twice, independently.** The renderer's paste-time check is what a developer actually
  sees and reacts to; the main process's re-check before building the outgoing command is the
  constitution's own non-negotiable gate on a sandboxed renderer's input, not a redundant formality
  (research.md Decision 3, FR-018).
- **The large-text chip is a renderer-only illusion over a plain textarea.** The textarea's real
  value always holds a short literal label; a positioned overlay (reusing spec 001's ghost-text
  technique, research.md Decision 10) makes it look and act like a clickable inline chip. Nothing
  about OMP's wire contract or Refract's send path changes for this half at all (research.md
  Decision 6).
- **One shared attachment strip, not two competing surfaces.** Images and text chips both render in
  the same strip above the message box; its height adapts to its tallest pending item rather than
  needing a second location for "large" images (research.md Decision 9, resolving the spec's
  Clarifications entry).
- **Failures are always visible, never silent.** A paste that fails validation, or a send OMP itself
  rejects over an image, is shown to the developer with the draft and any other pending attachment
  left intact (FR-003, FR-019, Edge Cases).

## Build order and dependencies on other specs

- **Depends on spec 001**: the message composer (`MessageInput.tsx`), its existing queue-chip
  mechanics (FR-010 to FR-012), its ghost-text ovelay technique (T103, FR-058, reused by research.md
  Decision 10), and the existing `chat.send`/`chat.sendNow` IPC methods this spec extends rather than
  replaces. Both user stories build directly on spec 001's already-shipped composer; neither needs
  any other spec's code.
- **No dependency on specs 003, 004, 006, 007, or 008**: this spec touches only the chat composer and
  its own send path; it does not touch the right pane, Settings, updates, themes, or the profile
  menu.
- **Nothing else in the repository depends on this spec**: no other spec's tasks.md references
  composer attachments.
- **Independently buildable stories**: User Story 1 (images) and User Story 2 (the text chip) touch
  different parts of `MessageInput.tsx`'s paste handler and different new components; either can be
  built and verified on its own, with User Story 1 first per its P1 priority (spec.md).

## Complexity Tracking

None.
