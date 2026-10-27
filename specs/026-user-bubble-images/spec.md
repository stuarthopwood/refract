# Feature Specification: Message images in the user bubble

**Feature Branch**: `026-user-bubble-images`
**Status**: Draft
**Input**: Issue #513 (display slice of #431). Spec 009 (`specs/009-composer-attachments/`) attaches pasted images to a prompt; once sent, the bubble shows only text. Decisions: the "Decided (Stuart, 2026-10-13)" comment on #513 and the 2026-10-27 grill below. PR #783 (Electron) was closed; its renderer files are reused and its main-process half is ported to `src-tauri/`. Numbered 026 so it cannot clash with a parallel lane's 025.

## Clarifications

### Session 2026-10-27 (grill, Stuart present)

- Q: Thumbnails generated in Rust? -> A: No. The Rust build has no image-decode crate and gains none. The backend serves the original bytes (already capped at 20 MiB and 40 MP) as a data URL on demand; the webview scales it with CSS; the renderer loads lazily per tile and keeps a small cache by image id.
- Q: Where do the bytes of a live inline image live? -> A: In a bounded per-Session in-memory store in Rust, keyed by a generated id and evicted with the Session. A `blob:sha256:<hash>` reference uses the hash as its id and is read from OMP's blob folder.
- Q: Scope? -> A: Viewer has previous and next with arrow keys, Esc and a close button, focus return, and shows type and size. No zoom or pan, no Copy image or Save as, no images from assistant or tool-result content, no optimistic-swap logic (pending attachments show as today until the user item lands).
- Q: Layout defaults? -> A: One image at natural size up to the bubble width and 320 px tall, never upscaled. Two or more: a grid of equal cropped tiles, 2 across (3 when the bubble is wide), at most 4 tiles with `+N` on the last past that.
- Q: Glossary? -> A: **Message image** and **Image viewer** added to `CONTEXT.md`.
- Clarify pass (2026-10-27, `/speckit.clarify`): no open ambiguities beyond FR-005's store scope, resolved above. An unsupported or over-cap image part yields an image entry the viewer shows as unavailable (the message is never dropped). Opaque OMP strings other than `blob:sha256:` and valid base64 are treated as invalid inline data.
- Both live frame shapes (inline base64 and `blob:sha256:` reference) are read defensively, branching on the value's own prefix (probe: live echo is inline, history is a blob reference).

## User Scenarios and Testing

### User Story 1 - See what I sent (P1)

A developer pastes two screenshots, types a question and sends. The bubble shows the images above the text.

**Acceptance Scenarios**:

1. **Given** a message with one image, **When** it appears in the transcript, **Then** the image shows above the text at natural size up to the bubble width and 320 px tall, never upscaled, with a 1 px border.
2. **Given** a message with six images, **Then** four tiles show in a 2-across grid (3 when wide), the last labelled `+2`.
3. **Given** a message with only images, **Then** there is no empty text block.
4. **Given** the pane is 320 px wide, **Then** nothing overflows horizontally and the layout does not jump as images load (the aspect ratio is reserved when the size is known).
5. **Given** a message with no images, **Then** the bubble is unchanged.

### User Story 2 - Enlarge an image (P1)

**Acceptance Scenarios**:

1. **Given** a Message image, **When** the user clicks it or presses Enter, **Then** the Image viewer opens at up to the viewport size with its file type and size.
2. **Given** the viewer shows image 1 of 3, **When** the user presses the right arrow or the next button, **Then** image 2 shows; the left arrow and previous button go back.
3. **Given** the viewer is open, **When** the user presses Esc or the close button, **Then** it closes and focus returns to the tile that opened it.

### User Story 3 - Images survive a restart (P1)

**Acceptance Scenarios**:

1. **Given** a Session whose saved history holds `blob:sha256:` image references, **When** it is reopened, **Then** the Message images show, read from OMP's blob folder.
2. **Given** a blob that is missing, unreadable, over the size cap or not a supported image, **Then** the tile shows an "Image no longer available" placeholder instead of a broken box.
3. **Given** a long history with many images, **Then** opening it does not stall: only visible tiles load.

## Requirements

- **FR-001**: A `user` transcript item MUST carry `images?: { id, mimeType, byteLength, width?, height? }[]`, filled from `image` content parts in both the live frames and saved history. Full image bytes MUST NOT be stored in the transcript or sent over the transcript channel.
- **FR-002**: The image part MUST be read by its `data` prefix: `blob:sha256:<64 hex>` becomes a blob-backed image whose id is the hash; anything else is inline base64, validated and held in the per-Session store under a generated id.
- **FR-003**: A new typed command MUST return one image as a data URL by id. Only a validated id is accepted; an unknown id, a missing blob or an invalid image returns a typed "unavailable" result.
- **FR-004**: Blob reads MUST happen only in the backend, from the fixed folder `%USERPROFILE%\.omp\agent\blobs\<hash>` (extensionless; an extension-suffixed file is tried second), the hash matched against `^[0-9a-f]{64}$`, the path built only from that folder and the hash, the size capped at 20 MiB, the magic bytes checked against png, jpeg, gif and webp, and the pixel count capped at 40 MP. No path or file name from a message is used. No filesystem scope is broadened.
- **FR-005**: The in-memory store MUST be bounded (a total byte budget and an entry cap, oldest evicted first) and keyed by a deterministic content id, so a message's start and end frames share one entry. An evicted image shows the unavailable placeholder, never a wrong image. (Clarify 2026-10-27: the transcript builder has no Session handle, so the store is process-wide and bounded rather than per Session; this supersedes the grill's "per-Session" wording.)
- **FR-006**: The bubble MUST render Message images through shared components in `src/renderer/components/` (a tile grid and the generalised viewer), above the text, in attach order, with the layout rules in the Clarifications.
- **FR-007**: Each tile MUST be a button of at least 24 px with an accessible name "Image N of M attached to your message, TYPE, SIZE. Open larger view", `alt=""` on the picture, a 1 px border that survives forced-colors, lazy loading, and no animation under reduced motion.
- **FR-008**: The Image viewer MUST be a modal dialog with a focus trap, Esc and close button, previous and next with arrow keys, the type and size shown, and focus returned to the opening tile. The composer's pending-attachment preview MUST keep working through the same component.
- **FR-009**: The viewer and tiles MUST treat images as inert pictures (supported types only; never SVG).
- **FR-010**: A failed or unavailable image MUST show the text alternative "Image no longer available".

## Success Criteria

- **SC-001**: After a restart, every sent image whose blob still exists shows in its bubble.
- **SC-002**: Any image opens enlarged in one click or one key press and closes with Esc, with focus back where it was.
- **SC-003**: No horizontal overflow at 320 px, verified live.
- **SC-004**: Opening a long history with many images shows the first screen without waiting for off-screen images.
