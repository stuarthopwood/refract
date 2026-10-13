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

## 11. Path-based attach reuses `resolveInWorktree` only for the RELATIVE case; an absolute path's own FINAL destination is not worktree-contained -- but every link along the way still is fully vetted

**Decision**: `attachments.readImageFile` branches on `path.isAbsolute(token)`. An absolute token
is walked ONE SEGMENT AT A TIME (`resolveNoFollowUnrooted`, `files.ts`), re-vetting every
symlink/junction's own target text (`isUnsafeToken`) before ever following it, only THEN
canonicalised via `fs.realpath` -- its FINAL destination is not required to stay inside any
worktree, but every hop along the way is. A relative token is resolved and contained through the
existing `resolveInWorktree` (`files.ts`, issue #610) unchanged — the single existing containment
surface, never a second implementation.

**Rationale**: #514's own spec explicitly lists "an absolute Windows path" (a screenshot in
Downloads, Pictures, or anywhere else on disk) as the common case this feature exists for. The file
explorer's own `resolveInWorktree` enforces strict worktree containment — correct for THAT feature
(browsing a Session's own repository), wrong here: it would reject the exact files-anywhere-on-disk
case the issue is written for. This is a user-initiated READ (a paste, a confirmed typed path, or a
drop) of a file the user chose to attach, matching the trust level the existing repository folder
picker (`repositories.ts`) already grants a user's own absolute choice — not a new, wider trust
boundary, an existing one this feature simply also qualifies for.

**Corrected (PR #723 gate round 1, Sec1/Verif1 HIGH, reproduced live: a symlink to
`\\127.0.0.1\C$\...` made `fs.realpath` take ~7.8s and open a real SMB session)**: this decision's
own ORIGINAL wording claimed the pasted/dragged text is "never agent/tool/model-authored" -- that
is false. Pasted text very often comes straight from the agent's own transcript (the user copies a
line the agent printed), and an agent can plant a symlink inside the worktree pointing at a UNC
share, then print its absolute path; the user pasting or dragging that path is still a genuine
user action, but the TEXT itself is exactly as untrusted as any other agent-authored string
elsewhere in this app. The fix is NOT to add worktree containment back (that would defeat the
whole point of this decision) -- it is to vet every LINK the absolute path passes through, exactly
as `resolveNoFollow` already does for the relative/worktree-contained branch, while still allowing
the link's ultimate, fully-vetted target to live anywhere on disk. "User-initiated" now describes
only the ACT of pasting/dragging, never a trust claim about the text's own origin.

**Addendum (PR #723 gate round 2, Sec2 Low/Verif2 Medium)**: round 1's fix above still called
`fs.realpath(walked.path)` after the segment-by-segment walk, "only to canonicalise casing/8.3
short names" -- but `fs.realpath` follows links, and `walked.path` is already link-free, so that
call bought nothing except a second, unvetted chance for a link swapped in between the walk and
this call to be followed. Removed; `walked.path` is handed to the reader as-is. **Accepted
residual risk** (the lane's own measurement, not independently reproduced by every reviewer: 1/1228
runs under a tight symlink-swap loop): a window still exists between the walk's last `fs.lstat`
and the reader's own `fs.open` -- a link swapped into an already-checked segment in that window
could still be followed. This is the same RACE WINDOW `resolveNoFollow`'s own doc comment
(`files.ts`) already documents for the worktree-relative branch below (round 3 correction, Code3
Low: NOT "the exact same accepted residual" -- the relative branch's window ends in
`resolveInWorktree`'s own `fs.realpath` followed by a containment rejection, a backstop this
absolute branch has no equivalent of; a link swapped in during this window is followed by
`fs.open` and its bytes read with no check after, so a swapped-in image located ANYWHERE ELSE on
disk could be attached, on top of the shared UNC/NTLM risk); winning it requires a process with
symlink-creation privilege already running locally as the user racing a paste/drop, i.e. the same
local attacker who could already reach a UNC path directly -- accepted, not mitigated.

## 12. Pixel-count cap: parsed from the image's own header bytes, no new npm dependency

**Decision**: `shared/images.ts` gains `readImageDimensions(bytes, mimeType)`, a pure function that
reads width/height straight out of each supported format's own fixed-offset header fields (PNG
IHDR chunk; GIF Logical Screen Descriptor, expanded by every Image Descriptor's own bounds; JPEG
SOF marker segment, scanned past intervening markers; WebP's VP8/VP8X/VP8L chunk, per its
container spec) — no image-decoding library, no new dependency, no `pnpm-lock.yaml` change.
`MAX_IMAGE_PIXELS` (40,000,000) moves here from being a renderer-only `attachments.ts` constant,
so the main-process reader enforces the exact same cap by number, never its own separately-tuned
copy.

**Rationale**: the renderer's own decompression-bomb guard (Decision 3 area) only ever runs inside
`reencodeToPng`'s browser `createImageBitmap`/canvas path — no such API exists in the main process,
and a path-based read has no canvas step to piggyback the check onto at all. Adding a dependency
(`image-size` or similar) for four well-documented, fixed-offset header formats is disproportionate
surface for what a few dozen lines of pure byte-reading already covers completely.

**Corrected (PR #723 gate round 1, Code1 Medium)**: this decision's own ORIGINAL wording claimed a
header too short/malformed to parse is "treated as 'could not verify dimensions' ... not a hard
rejection" -- that is false and was never the actual intent once implemented: the caller REFUSES
(fail-closed) any `null` result for any format. A genuinely too-short-to-decode file is never
attached, never "possibly fine" -- the magic-byte signature check proving the declared TYPE is
correct says nothing about whether the DIMENSIONS are safe, so a header gap is treated the same as
any other decompression-bomb-shaped signal: refused.

**Addendum (PR #723 gate round 2, Sec2 Medium)**: the GIF case originally read only the Logical
Screen Descriptor's own nominal canvas size -- a crafted file can declare a tiny screen (even 1x1)
while its first Image Descriptor describes a far larger frame that real-world decoders (including
Chromium's) expand the canvas to fit rather than clipping, bypassing the pixel cap entirely. Fixed
to walk past the optional Global Color Table and any Extension blocks to the first Image
Descriptor and report `max(screen, frame bounds)` instead.

**Addendum (PR #723 gate round 3, Code3 Low, reproduced: a 10x10 screen plus a 60000² SECOND
frame was accepted)**: round 2's walk stopped at the FIRST Image Descriptor -- a multi-frame GIF's
second (or later) frame could still be oversized and bypass the cap. Fixed to walk every Image
Descriptor in the buffer (skipping each frame's own optional Local Color Table and
LZW-compressed image-data sub-blocks to reach the next one), taking the max bound across every
frame found, not only the first; cheap, since the whole file is already in memory for this check.

## 13. Mixed-paste text is NEVER altered; only a path-only paste replaces its own text

**Decision**: pasted/typed text that, once trimmed, is nothing but image-path-looking token(s) has
that text replaced by the resulting attachment(s) (FR-022). Text that mixes a path with other words
is inserted completely unchanged — the path stays exactly where it was — and each resolvable path
within it is ALSO attached, in the background, with no `[Image #N]` label substituted in (FR-023).

**Rationale**: #514's own spec already draws this exact line (point 3): a mixed paste's own text is
the ONLY place the resolved path remains visible to the developer once attached, and it is also
what the agent reads from the plain message string — removing or replacing it there would leave
neither a visible path nor a tool-usable one. OMP's own terminal convention (a visible `[Image #N]`
label plus a hidden note repeating the source path) was considered and rejected as unnecessary
complexity here: the raw path text already serves exactly that purpose without a second mechanism.

## 14. Typing detection deferred; paste-only for v1

**Decision**: #514's path detection runs on paste only. Detecting a completed path while typing
(stat-on-every-keystroke after a trailing space/Enter, an Undo/"Keep as text" toast, its own timing
edge cases) is explicitly out of scope for this round — a disclosed follow-up, not built.

**Rationale**: #514's own issue text flags this exact question with its own leaning
(`[INFERENCE: paste only, plus typing with Undo later]`). Typing detection is real additional
surface (a live, cancellable auto-conversion plus its own reversal UI) disproportionate to this
round's scope; paste-time detection alone already covers the issue's primary motivating case
(Explorer's "Copy as path", always arriving via paste). The Settings switch (FR-024) is still built
now regardless, since a false-positive path-shaped match inside an ordinary paste remains possible
even without typing detection.

## 15. Drop target is the whole chat pane; per-pane, never per-focus

**Decision**: `onDrop`/`onDragOver`/`onDragEnter`/`onDragLeave` attach to `ChatPane.tsx`'s own root
container (one per rendered pane, each already carrying its own `sessionId`), not to
`MessageInput.tsx`'s textarea specifically. A split layout therefore drops onto whichever pane the
pointer is physically over, independent of which pane is currently focused.

**Rationale**: #432's own issue names "a chat pane" repeatedly as the target, and a pane-scoped
listener naturally satisfies "the pane under the cursor wins, not the focused one" (the issue's own
split-view requirement) for free, since each pane's own DOM subtree only ever receives drag events
that are physically over it — no manual pointer-position/pane-bounds calculation needed.

## 16. `webUtils.getPathForFile` is bridged through preload, never imported directly in a renderer file

**Decision**: `src/preload/index.ts` imports `webUtils` from `'electron'` and exposes
`window.refract.attachments.getPathForFile(file)`; no renderer `.tsx`/`.ts` file imports from
`'electron'` directly.

**Verified** (a real `tsc --noEmit -p tsconfig.web.json` run during this feature's own
development): `node_modules/electron/electron.d.ts` carries `/// <reference types="node" />` at
its own top. Once any file inside the `tsconfig.web.json` program imports from `'electron'` (even
only its `Renderer`-namespace members, which `webUtils` is documented to be safely callable from
under context isolation), that triple-slash reference pulls Node's ambient `setTimeout` overload
into the WHOLE program — confirmed to silently change five unrelated files' own
`setTimeout(...): number` (DOM lib) return type to `NodeJS.Timeout`, breaking their typecheck.
`tsconfig.node.json` already expects Node's ambient types (`"types": ["electron-vite/node",
"node"]`), so routing the one call through a preload-exposed, plain synchronous bridge function
avoids the cross-contamination entirely — no IPC round trip either, since `webUtils` itself does no
main-process work, it only reads a `File` object's own already-resolved path locally.

## 17. #513 probe: a user message's `image` content part carries full inline base64 LIVE, but a reopened/history read carries only a `blob:sha256:<hash>` reference -- resolved by reading OMP's own blob folder directly, never over RPC

**Decision**: `transcript.ts` reads an `image` content part on a `user` message the same way in
both `applyFrame` (live) and `fromHistory`: `data` starting with `blob:sha256:` is a reference
resolved by a new main-process-only reader against OMP's own blob store
(`%USERPROFILE%\.omp\agent\blobs\<sha256>.<ext>`, never over RPC -- no such RPC command exists,
confirmed below); any other `data` value is treated as inline base64 and used directly. Both
shapes can legitimately appear for the SAME message depending on when it is read (Decision 17a/b),
so the reader branches on the value's own prefix rather than on which code path (live vs. history)
called it.

**Sourced** (own live RPC probe this session, `omp/18.10.1`, protocol v2, `--mode rpc`, a scratch
`--no-session` cwd, `prompt` with a fresh 1x1 PNG never seen before by this profile): the
`message_start`/`message_end` frames AND an immediate `get_messages` call against the SAME live
process all echoed the user message's `image` content part with `data` equal to the EXACT base64
string sent -- `{"role":"user","content":[{"type":"text","text":"probe-513 test message"},
{"type":"image","data":"iVBORw0KGgo...","mimeType":"image/png"}],...}`. No `[Image #N]` caption was
synthesised into the text part for this RPC-originated image (that caption, seen in real recorded
`.jsonl` sessions below, is the TUI's own paste-handling inserting literal placeholder text into
the composed message before submission -- not something OMP's engine adds server-side for a
caller-supplied `images` field). This directly confirms issue #513's own open question ("Does the
live user message frame include the image inline or as a blob reference?"): inline, for an
image not yet stored under its content hash.

**Sourced** (reading real, previously-recorded `.jsonl` session files under
`~/.omp/agent/sessions/**`, structure only, per this session's own skill guidance -- never image
bytes or chat text content beyond what grounds this shape): multiple independent historical user
messages with images, from several real Sessions spanning July through October 2026, all show the
SAME persisted shape: `{"role":"user","content":[{"type":"text","text":"<message, sometimes
prefixed by the TUI's own \"[Image #1, WxH]\" marker>"},{"type":"image","data":"blob:sha256:<64 hex
chars>","mimeType":"image/png"}],...}` -- NEVER inline base64 once the message has round-tripped
through OMP's own on-disk persistence. This matches issue #513's own finding verified against a
real session file ("the user message content has `{ type: \"image\", data: \"blob:sha256:<64
hex>\", mimeType }`... The bytes live in OMP's blob store, `%USERPROFILE%\.omp\agent\blobs\
<sha256>.<ext>`").

**Verified** (`rpc.md`'s full Command Schema and Event Stream Schema sections, read exhaustively
this session): there is no RPC command that resolves a `blob:sha256:<hash>` or `local://<name>`
reference into bytes for a host process. The only place either reference is meant to be read is
INSIDE the agent's own tool execution (the model/agent's own `read` tool, confirmed by several
real `toolResult` entries in the same session files showing `blob:sha256:` values the agent reads
directly) -- never a host-facing capability `set_host_uri_schemes`/a new RPC command would expose.
Issue #513's own technical notes independently reach the identical conclusion and specify the fix:
read the blob file directly in the main process (constitution Principle V), validating the hash
against a strict `^[0-9a-f]{64}$` pattern and building the path from the fixed blob folder --
never from any path/filename carried in the message itself.

**Rationale for branching on the `data` prefix rather than on live-vs-history**: a single session's
`get_messages`/history read can mix both shapes for the OLDEST vs. the MOST RECENT message once an
image has round-tripped through at least one persistence cycle (for example: `--resume`ing a
session, sending one more image-carrying message, then reading history again) -- there is no
guarantee every entry in one `get_messages` response shares one shape. A value-prefix check is the
only rule that is correct for every message in a mixed list, not just the common case.

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
