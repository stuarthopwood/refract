# Feature Specification: Composer attachments

**Feature Branch**: `009-composer-attachments`

**Created**: 2026-10-04

**Status**: Draft

**Input**: User description: "Composer attachments: paste an image to attach it to the next message, paste a large block of text to collapse it into a reusable chip"

## Clarifications

### Session 2026-10-04

- Q: Stuart's wording says a pasted image's thumbnail sits "inline or above the composer depending on size," but Refract's message box is a plain textarea, which cannot embed a true inline image inside its own text value. What does "inline or above" mean here? -> A: Both images and text chips render in one shared attachment strip directly above the message box. A small image's thumbnail renders compactly, flush alongside any text chips in that one row ("inline" with them); an image whose thumbnail needs more vertical room renders as a larger preview block, which grows the strip upward above that row. "Inline" and "above" describe the same strip adapting its own height to what was pasted, not two separate locations.
- Q: What size turns a pasted block of plain text into a chip rather than landing in the textarea as before? -> A: Over 800 characters, regardless of line count (research.md Decision 8 records the figure and its reasoning; it is this spec's own default, not a number Stuart specified, and is open to revision once seen in use, the same pattern spec 008 used for its avatar size cap).
- Q: A clipboard paste can carry more than one representation at once (for example, copying a cell from a spreadsheet can offer both an image and plain text). Which wins? -> A: An image representation always wins when present; the large-paste-to-chip behavior is reached only when the clipboard carries no image representation at all.
- Q: Can more than one image or text chip be pending on a single draft message at once? -> A: Yes. Each pasted image and each oversized pasted text block becomes its own independent pending attachment; removing or sending one never affects any other.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Attach a pasted image to the next message (Priority: P1)

A developer copies a screenshot or an image from somewhere else on their machine and pastes it directly into Refract's message box instead of describing it in words. The image appears as a small thumbnail above the message box; clicking it shows the full image in a modal. When the developer sends the message, the image goes to the agent as a real image attachment the agent can actually look at, not just a picture shown in Refract's own UI.

**Why this priority**: Describing a UI bug, an error dialog, or a diagram in words is slow and lossy; showing it is immediate and precise. This is the half of the feature with the larger payoff and the only half that needs a new wire capability, so it anchors the MVP.

**Independent Test**: Can be fully tested by pasting a PNG into the message box, confirming a thumbnail appears and opens a modal on click, sending the message, and confirming the agent's own reply demonstrates it actually received image content (for example, asking it to describe what is in the picture).

**Acceptance Scenarios**:

1. **Given** an empty message box, **When** the developer pastes a PNG from the clipboard, **Then** a thumbnail appears in the attachment strip above the message box and the textarea's own text is unchanged.
2. **Given** a pending image thumbnail, **When** the developer clicks it, **Then** a modal opens showing the full-size image; pressing Esc or clicking outside the modal closes it and returns focus to the thumbnail.
3. **Given** a pending image thumbnail, **When** the developer sends the message, **Then** the image is included as a real image attachment on the command Refract sends for that message, and the attachment strip clears once that send is accepted.
4. **Given** a clipboard image in a format other than PNG, JPEG, GIF, or WebP, **When** the developer pastes it, **Then** it still becomes a pending attachment, re-encoded to PNG before it is ever sent.
5. **Given** a clipboard image whose decoded size is over 20 MiB, **When** the developer pastes it, **Then** it is rejected with a clear message naming the limit, never becomes a pending attachment, and is never sent.
6. **Given** a pending image attached to a message sent to a text-only model, **When** OMP's own vision-description step takes several extra seconds before acknowledging the message, **Then** the composer continues showing its ordinary sending/working state, never an error or a stalled appearance.
7. **Given** two pasted images pending at once, **When** the developer removes one with its own remove control, **Then** the other stays pending and unaffected, and sending still attaches the one that remains.

---

### User Story 2 - Collapse a large pasted block of text into a chip (Priority: P2)

A developer pastes a large block of text, for example a long error log or an existing code file, into the message box. Instead of flooding the textarea with hundreds of lines, it collapses into a short, clickable chip that stands in its place. Clicking the chip shows the full pasted text in a modal. Sending the message still sends the exact text that was pasted, in its original place in the draft.

**Why this priority**: This makes long pastes easier to review and edit around without losing anything, but needs no new wire capability (the message Refract sends is already a plain string) and is less critical than getting a picture to the agent at all, so it follows Story 1.

**Independent Test**: Can be fully tested by pasting a long block of text (over the chip threshold) into the message box, confirming it collapses into a chip that opens a modal with the full text, sending the message, and confirming (for example from the agent's own reply, or a transcript entry) the agent received the complete original text, not a placeholder.

**Acceptance Scenarios**:

1. **Given** an empty message box, **When** the developer pastes a block of plain text at or under the chip threshold, **Then** it is inserted into the textarea exactly as it always has been, with no chip created.
2. **Given** an empty message box, **When** the developer pastes a block of plain text over the chip threshold, **Then** a short labelled chip appears in its place in the draft instead of the raw text, and the chip is clickable.
3. **Given** a pending text chip, **When** the developer clicks it, **Then** a modal opens showing the full original pasted text, read-only and scrollable; Esc or clicking outside closes it and returns focus to the chip.
4. **Given** a message whose draft contains one or more text chips, **When** the developer sends it, **Then** each chip's full original text is substituted back into the message string at its own original position, so the agent receives exactly the text that was pasted.
5. **Given** a pending text chip, **When** the developer deletes it from the draft the same way they would delete any other text, **Then** it is removed and no longer substituted back on send, while the rest of the draft is unaffected.
6. **Given** two oversized pastes in the same draft, **When** the developer sends the message, **Then** both chips substitute their own full text back correctly, independently of each other and of their order in the draft.

---

### Edge Cases

- A clipboard paste that offers both an image and a plain-text representation at once (for example, a spreadsheet cell) is handled as an image paste; the text representation is not also turned into a chip.
- Pasting into a message box that already has other pending attachments (images, chips, or both) adds to them rather than replacing them.
- A paste that fails to decode as a usable image (corrupt data, an unsupported binary format Refract cannot even re-encode) shows an inline error and attaches nothing, leaving the rest of the draft untouched.
- Sending while a turn is already running (the message is queued as a steer or follow-up instead of starting immediately) carries pending attachments exactly the same way an idle send does.
- If OMP itself reports a failure tied to a send that carried an image (rather than Refract's own pre-send validation catching it), that failure surfaces to the developer the same way any other failed send does; the draft and its attachments are not silently discarded.
- A text chip's placeholder label, if the developer edits it so it no longer matches intact (rather than deleting it outright), is treated as no longer present: it drops from the pending list and nothing is substituted for it on send.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Pasting an image onto the message composer (a browser paste event carrying an image clipboard representation) MUST create a pending image attachment shown as a thumbnail in a shared attachment strip above the message box, and MUST NOT insert any image data into the textarea's own text value.
- **FR-002**: A pasted image not already PNG, JPEG, GIF, or WebP MUST be re-encoded to PNG before it becomes a pending attachment; Refract MUST NOT rely on OMP's own fallback/conversion behaviour for an unsupported format.
- **FR-003**: A pasted image whose decoded size would exceed 20 MiB MUST be rejected before it becomes a pending attachment, with a clear inline message naming the limit; Refract MUST NOT attempt to shrink it to fit, and MUST NOT send it.
- **FR-004**: Clicking a pending image's thumbnail MUST open a modal showing the full-size image; Esc or clicking outside the modal MUST close it and return focus to the thumbnail.
- **FR-005**: More than one image MAY be pending at once; each has its own thumbnail and its own remove control, independent of the others and of any pending text chip (FR-011).
- **FR-006**: Sending a message with one or more pending image attachments MUST include them as the `images` field of the command Refract actually sends to OMP for that message (never only as a local UI decoration); each entry MUST carry exactly the base64 payload and mime type of the attachment the developer saw, never a file path or a URL.
- **FR-007**: Pending image attachments MUST clear from the composer once the message that carried them is accepted by OMP (FR-006's command is sent), not only once the agent's turn finishes.
- **FR-008**: Refract MUST NOT show an error, timeout, or stalled state to the developer solely because a message carrying an image takes up to the extra 20 seconds OMP's own vision-description step can add before acknowledging it; the composer's ordinary sending/working indication continues through that delay exactly as for any other message.
- **FR-009**: Pending image and text-chip attachments both render in one shared attachment strip directly above the message box (never floating elsewhere); the strip is hidden entirely while nothing is pending, and a small image's thumbnail renders compactly in the same row as any text chips while a larger image's thumbnail grows the strip to a taller preview block (Clarifications).
- **FR-010**: Pasting a block of plain text at or under the chip threshold (FR-011) MUST insert it into the textarea exactly as it does today, unchanged.
- **FR-011**: Pasting a block of plain text over 800 characters MUST collapse it into a pending text chip, replacing the raw text at the position it was pasted, instead of inserting it into the textarea (Clarifications; research.md Decision 8).
- **FR-012**: A pending text chip MUST show a short label (its first line, truncated, plus its full character count) and MUST be clickable, opening a modal with its full original text, read-only, selectable, and scrollable; Esc or clicking outside closes it and returns focus to the chip.
- **FR-013**: Sending a message MUST substitute each pending text chip's full original text back into the message string at the exact position it was pasted, so the plain string reaching OMP is exactly what the developer would have gotten by pasting the whole block directly into the textarea; this MUST use the existing plain `message` string with no new OMP capability and no `images` entry.
- **FR-014**: Removing a pending text chip (including by editing or deleting its label the same way any other draft text is edited) MUST remove exactly that pasted block's substitution, leaving every other part of the draft and any other pending chip unaffected.
- **FR-015**: More than one oversized paste MAY be pending in one draft at once; each becomes its own chip and is substituted back at its own original position independently of the others.
- **FR-016**: Every new control this spec adds (a thumbnail, its remove control, a text chip, a modal's close control) MUST have an accessible name, and opening or closing a modal MUST manage focus the way every other dialog in the app does: focus moves into the modal on open and returns to the control that opened it on close.
- **FR-017**: A message sent while a turn is already running (queued as a steer or follow-up, spec 001 FR-010 to FR-012) carries its pending attachments exactly as an idle send does; attachments are not limited to the idle-send path.
- **FR-018**: Refract MUST validate a pending image's mime type and decoded byte size again in the main process before it is ever placed in an outgoing command, never trusting the renderer's own check alone (constitution Principle V: the renderer is sandboxed and untrusted for anything crossing into a privileged operation).
- **FR-019**: If OMP reports a failure tied to a send that carried an image, Refract MUST surface that failure to the developer the same way any other failed send is shown, and MUST NOT silently drop the image or the draft without telling the developer.

### Key Entities

- **Pending image attachment**: a clipboard-pasted image not yet sent; held in the renderer until the message carrying it is sent, with its base64 payload, mime type, decoded byte size, and a thumbnail/modal preview.
- **Pending text chip**: a clipboard-pasted block of text over the chip threshold, not yet sent; held in the renderer with its full original text, a short label, and the position in the draft its label currently occupies.
- **Attachment strip**: the shared row above the message box holding every pending image and text chip for the draft currently being composed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every image attached through paste-and-send reaches the agent as a real image attachment on that message, 100% of the time, measured by the `images` field being present and non-empty on the command Refract sends whenever at least one pending image attachment existed at send time.
- **SC-002**: A paste at or under the chip threshold behaves identically to the composer's existing paste behaviour, with zero measurable regression.
- **SC-003**: A pasted image whose decoded size exceeds 20 MiB is rejected before any command reaches OMP, 100% of the time, with no crash and no silent loss of the rest of the draft.
- **SC-004**: Clicking any pending thumbnail or chip opens its full content in a modal every time it is clicked; closing it always returns focus to the control that opened it.
- **SC-005**: A non-vision model's extra admission delay for a vision-description call (up to 20 seconds) never produces a visible error or a stalled appearance in the composer.
- **SC-006**: Removing one pending attachment never alters the draft's other text or any other pending attachment.

## Assumptions

- Paste only. Drag-and-drop, a file picker, and camera capture are out of scope: Stuart's own wording names pasting specifically for both halves of this feature.
- A single browser paste event yields at most one image (standard Chromium clipboard-event behaviour, research.md Decision 7); pasting several images one at a time accumulates several independent pending attachments.
- The 800-character chip threshold is this spec's own default, not a number Stuart specified; research.md Decision 8 records the reasoning, open to revision once seen in use, the same pattern spec 008 used for its avatar size cap.
- This spec's `docs/DESIGN.md` rule for attachments is written by the implementation task that builds the feature, not by this spec-writing pass, matching how every other spec 001 feature's own doc-update task works.
- Depends on spec 001's message composer (`MessageInput.tsx`, the existing queue-chip mechanics FR-010 to FR-012, and the existing `chat.send`/`chat.sendNow` IPC) and its existing dialog and accessibility conventions; this spec extends those, it does not replace them.
- `specs/001-core-session-workspace/spec.md`'s own Assumptions (line 302) name "image attachments" as explicitly out of that spec's scope and deferred to "their own specs" — this is that spec.
- Windows 11 is the only supported platform, consistent with the constitution.
- No automated tests; Refract is a prototype verified by hand per quickstart.md, consistent with specs 001 and 008.
- No telemetry is added by this spec.
- Probe-before-design (constitution Principle IV) is already satisfied for the OMP wire-level facts this spec relies on: the `images` field, the `ImageContent` shape, the 20 MiB cap, the supported mime types, and the vision-description admission delay were all read directly from OMP's own `rpc.md` and source this morning (research.md Decisions 1 to 4), not assumed; no new probe task is scheduled for them.
