# Research: Composer attachments

Decisions for the implementation plan. "Sourced" means read directly from OMP's own documentation
or source this session (2026-10-04), not assumed. "Verified" means observed by reading Refract's
own current source in this repository. "Decision" (no source label) means this spec's own choice
where neither OMP nor the existing codebase pins a number, recorded the same way spec 008's
research.md recorded its avatar byte cap.

## 1. OMP's wire-level attachment support already exists; no new capability needed

**Decision**: use OMP's existing `images?: ImageContent[]` field on the `prompt` and `steer`
commands; add no new command type.

**Sourced** (`omp://rpc.md`, "Prompting"): `RpcCommand` already defines
`{ id?, type: "prompt", message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp" }`
and `{ id?, type: "steer", message: string, images?: ImageContent[] }` (OMP's `follow_up` and
`abort_and_prompt` command types also carry `images?: ImageContent[]`, but Refract never
constructs either of those two directly today — see Decision 5).

## 2. `ImageContent` shape Refract constructs

**Decision**: Refract only ever sends `{ type: 'image', data: string, mimeType: string }`; it never
sets `detail` or `providerFile`.

**Sourced**: `ImageContent` is `{ type: 'image', data: string (base64), mimeType: string, detail?:
'auto'|'low'|'high'|'original' (OpenAI-only, optional), providerFile?: ProviderFileReference
(optional, not something a host constructs) }`. Base64 is the only channel — confirmed by OMP's own
source comment in `anthropic-messages-server.ts`: "pi-ai's ImageContent only carries base64 +
mimeType" — never a file path or a URL. `detail` is an OpenAI-only hint Refract has no reason to
set (it never targets a specific provider's own tuning), and `providerFile` is explicitly not
something a host builds; both are simply omitted.

## 3. Size cap and supported formats, checked before any send

**Decision**: reject a pending image whose decoded byte length exceeds 20 MiB, and only ever send
`image/png`, `image/jpeg`, `image/gif`, or `image/webp`; re-encode anything else to PNG in the
renderer before it becomes a pending attachment (research.md Decision 7).

**Sourced**: `MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024` is OMP's own hard cap on the raw
base64-decoded byte length, checked before any resize attempt; a client must stay under this cap
itself, or OMP throws `ImageInputTooLargeError`. OMP does its own resize/re-encode after that check
passes, so no client-side pre-resize is mandated below the cap — Refract's own cap check is a pure
gate, not a resize step. `SUPPORTED_IMAGE_MIME_TYPES` in OMP's own `pi-utils/src/mime.ts` lists
exactly those four formats; anything else is encoded to PNG or JPEG on paste rather than relying on
OMP's own fallback/conversion path (this spec always re-encodes to PNG, the simpler of the two, since
a canvas re-encode has no reason to prefer JPEG's lossy compression for an arbitrary pasted image).

**Where the check happens**: the renderer checks size and mime type at paste time so a developer
sees the rejection immediately, before any IPC round trip; the main process checks both again,
independently, in `src/main/ipc/chat.ts`'s handlers before ever building an outgoing `prompt`/`steer`
command, since the renderer is sandboxed and untrusted for anything crossing into a privileged
operation (constitution Principle V) and a renderer bug or a stale clipboard read must not be the
only thing standing between a developer and an `ImageInputTooLargeError` surfacing as a confusing
raw provider error instead of Refract's own clear message.

## 4. Vision-description admission delay is tolerated, never treated as an error

**Decision**: the composer's existing "sending"/working indication (no dedicated attachment-upload
progress UI) continues unchanged through a message carrying an image; no new timeout or error state
is added for this delay.

**Sourced** (`omp://rpc.md`, "`prompt` payload"): prompt admission runs image normalization first,
and, only for a text-only model with vision description enabled, a vision-description call capped
at 20 seconds, before the prompt is acknowledged; past the cap the image is still saved and the
model is told its description is unavailable. This can delay a prompt's acknowledgement by up to
that long when an image is attached to a non-vision model. This is server-side behaviour Refract
does not implement and does not need to detect in advance (there is no signal, before sending,
telling a host whether the live model is vision-capable); Refract only needs to tolerate the delay
rather than showing a false error or timeout.

## 5. Refract's current `frames.ts` has no `images` field yet; only two command types need it

**Verified** (read `src/shared/frames.ts` this session): `PromptCommand` is
`{ type: 'prompt'; id: string; message: string; streamingBehavior?: 'followUp' }` and `SteerCommand`
is `{ type: 'steer'; id: string; message: string }` — neither has an `images` field, and there is no
local `ImageContent`-shaped type anywhere in the file. The file's own `RpcCommand` union is
`PromptCommand | SteerCommand | AbortCommand | RemoveQueuedMessageCommand | NewSessionCommand |
SwitchSessionCommand | GetStateCommand | GetMessagesCommand | NegotiateProtocolCommand |
ExtensionUiResponseFrame | GetAvailableCommandsCommand | PredictWordCommand |
PredictWordFeedbackCommand` — there is no `FollowUpCommand` or `AbortAndPromptCommand` variant at
all: Refract's own `SessionAgent.send` already implements OMP's follow-up queueing by sending
`prompt` with `streamingBehavior: 'followUp'` (per spec 001 tasks.md T024), never a standalone
`follow_up` command, and never constructs `abort_and_prompt`.

**Decision**: add `images?: ImageContent[]` to exactly `PromptCommand` and `SteerCommand` (the only
two command shapes Refract actually builds), and add the `ImageContent` type itself, matching
Decision 2's shape exactly (`type`, `data`, `mimeType` only). No `FollowUpCommand` or
`AbortAndPromptCommand` type is added, since Refract constructs neither.

## 6. The large-text-chip half needs zero new OMP capability

**Verified** (read `src/shared/frames.ts` this session, `PromptCommand.message: string`): the
message Refract sends is already a plain string, exactly as today. A "collapsed text chip" is pure
Refract-side composer UI and state: the full pasted text is kept locally and the exact same plain
string is sent on submit, unchanged from current behaviour. No field, command, or OMP-side change is
needed for this half at all.

## 7. The renderer captures the clipboard paste directly; no Electron-specific clipboard module

**Decision**: `MessageInput.tsx`'s existing paste handler reads the standard DOM
`ClipboardEvent.clipboardData.items`, extracts an image item as a `Blob` via `item.getAsFile()`,
and reads it with the standard `Blob`/`FileReader` or `Blob.arrayBuffer()` APIs; a non-PNG/JPEG/GIF/
WebP blob is re-encoded to PNG by drawing it to an off-screen `<canvas>` (`createImageBitmap` +
`canvas.toBlob('image/png')` or `canvas.toDataURL('image/png')`). None of this needs Electron's
main-process `clipboard` module or any IPC round trip before the image becomes a pending attachment
— only sending it (Decision 3's main-process re-check, plus the actual RPC command) crosses into
main.

**Sourced**: `ClipboardEvent`, `DataTransferItem`/`DataTransferItemList`, and the Canvas 2D /
`createImageBitmap` APIs used here are standard Web Platform APIs (MDN: "ClipboardEvent",
"DataTransferItem", "CanvasRenderingContext2D"), unrelated to Node integration; they already work in
a fully sandboxed, `contextIsolation: true`, `nodeIntegration: false` Chromium renderer — the same
renderer Refract already runs (spec 001 research.md decision 1) — with no special Electron
permission or main-process help required. This keeps the feature inside the renderer's existing,
already-sandboxed surface rather than adding a new main-process capability.

## 8. The chip threshold: 800 characters, regardless of line count

**Decision**: a pasted plain-text block collapses into a chip when it is over 800 characters; at or
under that figure it inserts into the textarea exactly as today.

**Rationale**: Stuart's own wording ("a large block of text, e.g. a big code snippet") names no
number. 800 characters is comfortably past a normal sentence or short snippet (so ordinary pastes
are never affected, satisfying SC-002's no-regression bar) and comfortably within what a short
function or a handful of log lines reaches, so the chip triggers for the kind of paste the feature
is actually for. A single character-count threshold (rather than a line-count rule) also catches a
long single-line paste (for example minified JSON or a long URL list) that a line-count-only rule
would miss. This is this spec's own default, the same pattern spec 008's research.md used for its
256 KiB avatar cap (decision 4 there): open to revision once seen in use, not re-derived from any
external source because none exists to derive it from.

**Alternatives considered**: a line-count threshold alone (for example, over 10 lines) — rejected,
because it misses a long single-line paste; a much lower or much higher figure — no basis to prefer
either without live use, so the mid-range figure above is chosen and recorded rather than guessed
silently.

## 9. Attachment strip sizing resolves the "inline or above" wording

**Decision**: one shared attachment strip sits directly above the message box. A thumbnail that
fits a compact row (roughly the height of a single chip, about 32 to 40 px) renders flush alongside
any text chips in that one row. A thumbnail that needs more room (a larger image, rendered at up to
roughly 96 to 120 px tall, preserving aspect ratio) renders as its own larger preview block, which
grows the strip's total height upward above the compact row rather than cropping or squeezing the
image down to fit.

**Rationale**: resolves the spec's Clarifications entry: "inline" and "above" are not two different
locations, they are the same strip adapting its own height to its tallest pending item. This keeps
exactly one attachment surface (no second, competing location to maintain) while still matching both
halves of Stuart's own phrase literally.

## 10. The text chip reuses the existing ghost-text overlay technique, not a new editor

**Decision**: a pending text chip's label is a short literal string inserted directly into the
textarea's own value at the paste position (so the plain-text draft model, send path, and existing
queue-chip mechanics are all untouched); a clickable, chip-styled overlay is rendered exactly over
that label's rendered position using the same text-metrics measurement `MessageInput.tsx` already
uses for ghost-text word completion (spec 001 T103, FR-058), giving the appearance and click target
of an inline chip without requiring a contenteditable rewrite of the composer.

**Rationale**: Refract's message box is a plain shadcn `Textarea`, which cannot embed a true
non-text, atomic, clickable object inside its own value — only a rich/contenteditable editor can do
that, and building one is a disproportionate architecture change for this feature. Spec 001 already
solved the adjacent problem (showing something that looks inline but is not really part of the
textarea's own value, and must track the textarea's scroll position and text metrics exactly) for
ghost-text suggestions; reusing that technique means no new rendering architecture is needed, only a
second kind of overlay content keyed by a label's character offset instead of the caret's.

**Consequence**: because the label is literal text in the textarea's value, a developer can select
and delete it with ordinary text editing (FR-014); because it is also the correlation key, editing
it so it no longer matches intact is treated the same as deleting it outright (Edge Cases) — the
pending chip entry is dropped on the next draft change rather than left dangling.

## Unknowns resolved

No `NEEDS CLARIFICATION` markers remain in the spec. Every OMP wire-level fact this spec's design
depends on (the `images` field, `ImageContent`'s shape, the 20 MiB cap, the four supported mime
types, and the vision-description admission delay) is Sourced above, read directly from OMP's own
`rpc.md` and source this session, not assumed — constitution Principle IV ("evidence before design")
is already satisfied for all of them, so no new probe task is scheduled in tasks.md for the RPC
wire shape itself. The two genuinely new facts this spec itself decides (the chip threshold, Decision
8; the compact-row/larger-preview-block sizing, Decision 9) are plain product defaults with no
external source to probe, recorded as Decisions rather than left unresolved, the same way spec 008
recorded its avatar byte cap.
