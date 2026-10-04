# Quickstart: verifying composer attachments

Refract is a prototype with no automated tests. Each check below is a manual run of the app.
Requirement and story numbers refer to [spec.md](spec.md); data and protocol details are in
[data-model.md](data-model.md) and [contracts/](contracts/).

## Prerequisites

- Windows 11, Git for Windows, Node 24 or newer, `pnpm`.
- `omp` 18.4.x or 18.5.x on `PATH` and signed in.
- A scratch git repository with at least one commit, added to Refract as a Repository, with at
  least one Session created and open (spec 001 quickstart Story 1).
- A small PNG and a small non-PNG image (for example a BMP or TIFF screenshot) ready on the
  clipboard to paste; one over 20 MiB if you want to exercise the reject path (a large, uncompressed
  BMP screenshot reaches this easily).
- A long piece of text (over 800 characters — for example an existing source file of a few dozen
  lines) ready on the clipboard to paste.

## Run

```
pnpm install
pnpm dev          # Electron with hot reload
pnpm typecheck    # must pass before a change lands on main
pnpm build        # must pass before a change lands on main
```

## Checks per story

**Story 1: attach a pasted image to the next message (FR-001 to FR-009, FR-018, FR-019)**

1. With an empty message box, paste a PNG. Expect: a thumbnail appears in an attachment strip above
   the message box; the textarea's own text is unchanged (still empty, or unchanged if you had
   typed something first).
2. Click the thumbnail. Expect: a modal opens showing the full-size image. Press Esc. Expect: the
   modal closes and focus returns to the thumbnail. Repeat, clicking outside the modal instead of
   Esc: same result.
3. Paste a non-PNG image (BMP or TIFF). Expect: it still becomes a pending thumbnail (re-encoded to
   PNG internally — confirm by checking the `images` payload sent in step 4 reports
   `mimeType: "image/png"` regardless of the source format).
4. Send the message (any text, with the image still pending). Expect: the attachment strip clears
   once the send is accepted; ask the agent to describe the picture in its reply, or inspect a
   temporary log of the `prompt`/`steer` command Refract actually sent, and confirm the `images`
   field is present and non-empty with the exact base64 payload and `image/png` mime type.
5. Paste two images before sending. Expect: two independent thumbnails; removing one with its own
   remove control leaves the other pending; sending still attaches the one that remains.
6. Paste an image over 20 MiB (or temporarily lower `MAX_IMAGE_INPUT_BYTES` in `src/shared/images.ts`
   to test with a smaller file, then revert). Expect: a clear inline message naming the limit, no
   thumbnail is created, and nothing is sent.
7. With a pending image attached, send to a model you know is text-only. Expect: the composer shows
   its ordinary sending/working indication throughout, even if the acknowledgement takes several
   extra seconds (OMP's own vision-description step, capped at 20 s); no error or stalled-looking
   state appears.

**Story 2: collapse a large pasted block of text into a chip (FR-010 to FR-015)**

1. Paste a short block of text (under 800 characters). Expect: it inserts into the textarea exactly
   as before — no chip, no change in behaviour.
2. Paste a long block of text (over 800 characters, for example a source file). Expect: a short
   labelled chip appears in its place in the draft instead of the raw text.
3. Click the chip. Expect: a modal opens with the full original pasted text, read-only and
   scrollable. Press Esc, or click outside. Expect: the modal closes and focus returns to the chip.
4. Send the message. Expect: inspecting a temporary log of the exact `message` string handed to
   `OmpProcess` (or the agent's own reply, if you ask it to repeat back what you pasted) shows the
   full original pasted text substituted back in, not the chip's short label.
5. Paste a long block of text, then delete the chip's label the same way you would delete any other
   text (select it, press Backspace/Delete). Expect: it is gone from the draft and nothing is
   substituted for it on send; the rest of the draft is unaffected.
6. Paste two separate long blocks of text in the same draft. Expect: two independent chips; sending
   substitutes both back correctly, each in its own original position.

## First-task gates

None. Every OMP wire-level fact this spec's design relies on (the `images` field, `ImageContent`'s
shape, the 20 MiB cap, the four supported mime types, the vision-description admission delay) was
already read directly from OMP's own `rpc.md` and source before planning (research.md Decisions 1 to
4), and Refract's own current `frames.ts` was read to confirm the exact shape being extended
(research.md Decision 5) — constitution Principle IV is already satisfied for all of them, so no
probe task runs before implementation here (unlike spec 001 and spec 008, which each had unresolved
OMP behaviour to probe first).
