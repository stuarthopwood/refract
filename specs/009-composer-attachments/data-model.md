# Data model: Composer attachments

Extends `specs/001-core-session-workspace/data-model.md`. No change to `registry.json`,
`settings.json`, or `processes.json`: every entity below is held only in the renderer's own
in-memory composer state for the draft currently being composed, plus the one wire-level addition
that crosses into the command Refract sends to OMP. Nothing here is persisted.

## Shared wire type (crosses the IPC and RPC boundary)

### `ImageContent` (new, `src/shared/frames.ts`)

```ts
export type SupportedImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageContent {
  type: 'image';
  data: string;                      // base64; the only channel OMP accepts (research.md Decision 2)
  mimeType: SupportedImageMimeType;
}
```

Refract never sets `detail` or `providerFile` (research.md Decision 2): both are omitted rather
than sent as `undefined`.

### `RpcCommand` additions (`src/shared/frames.ts`)

```ts
export interface PromptCommand {
  type: 'prompt';
  id: string;
  message: string;
  images?: ImageContent[];           // new
  streamingBehavior?: 'followUp';
}

export interface SteerCommand {
  type: 'steer';
  id: string;
  message: string;
  images?: ImageContent[];           // new
}
```

No other `RpcCommand` variant changes (research.md Decision 5: Refract never constructs a
`follow_up` or `abort_and_prompt` command).

### Shared constants (new, `src/shared/images.ts`)

```ts
export const SUPPORTED_IMAGE_MIME_TYPES: readonly SupportedImageMimeType[] =
  ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024; // 20 MiB, OMP's own cap (research.md Decision 3)

export const LARGE_PASTE_CHIP_THRESHOLD = 800;         // characters (research.md Decision 8)
```

One shared module so the renderer's pre-check (immediate feedback) and the main process's
independent re-check (constitution Principle V, research.md Decision 3) can never drift apart.

## Held in memory (renderer, per Session's composer)

### `PendingImageAttachment`

```ts
interface PendingImageAttachment {
  kind: 'image';
  id: string;              // uuid, local only, never sent
  mimeType: SupportedImageMimeType;
  base64: string;           // exactly the payload sent as ImageContent.data
  byteLength: number;       // decoded size; checked against MAX_IMAGE_INPUT_BYTES before this entry exists
  previewUrl: string;       // `data:${mimeType};base64,${base64}`, used for the thumbnail and the modal
}
```

Rules:

- Created only after the paste handler's own validation passes (format already supported, or
  re-encoded to PNG; size under the cap); a paste that fails either check never creates one (FR-002,
  FR-003).
- Removed when: the developer uses its remove control, or the message carrying it is accepted by
  OMP (FR-007) — never on a timer, never on the agent's turn finishing.
- Read-only once created: there is no "edit" action, only remove.

### `PendingTextChip`

```ts
interface PendingTextChip {
  kind: 'text-chip';
  id: string;        // uuid, local only
  text: string;       // full original pasted text, byte-for-byte, never modified
  label: string;      // literal substring inserted into the textarea's own value at the paste position
}
```

Rules:

- `label` is both the chip's visible text and its correlation key (research.md Decision 10): it is
  the first line of `text` (truncated to a readable length) plus a character count, with a
  disambiguating index appended when two pending chips would otherwise produce the same label (for
  example two pastes of the same short function, each producing "`function foo() {...` (842
  chars)"; the second becomes "`function foo() {...` (842 chars, #2)"). **Remediation (Critical,
  quality gate 2026-10-04): the index sits INSIDE the closing `)`, never appended after it** (the
  original "`... (842 chars) #2`" form made every disambiguated label a literal prefix-superstring
  of its own base label, so a plain substring lookup for the base label also matched inside the
  longer one — see `resolveChipOccurrences` in `attachments.ts` for the shared left-to-right
  resolution pass that `pruneDanglingChips`/`substituteChips`/the overlay's position-finding all
  now use instead of each independently calling `indexOf` on its own label.
- Created only when a plain-text paste (no image representation present, Edge Cases) is over
  `LARGE_PASTE_CHIP_THRESHOLD` characters; at or under the threshold no `PendingTextChip` is created
  and the raw text inserts normally (FR-010).
- Dropped automatically, with no explicit remove action needed, the next time the draft changes and
  `label` no longer appears intact in the textarea's value — this covers both an explicit delete and
  an edit that breaks the label (Edge Cases, FR-014).
- On send, every pending chip's `label` occurrence in the draft is replaced with its `text` before
  the resulting string becomes the `message` sent (FR-013); this substitution is renderer-only and
  never crosses into `ImageContent` or any new OMP field.

### `AttachmentImageFile` (new, #514/#432, `src/shared/ipc.ts`)

```ts
export interface AttachmentImageFile {
  mimeType: SupportedImageMimeType;
  base64: string;
  byteLength: number;
}
```

The main-process `attachments.readImageFile` reader's success payload -- deliberately the same
three fields `PendingImageAttachment` needs (mime type, base64 payload, decoded byte size) and
nothing else (never the resolved path or any other file metadata, FR-029). The renderer wraps this
into an ordinary `PendingImageAttachment` (a fresh `id`, a `previewUrl` built from the same
`mimeType`/`base64`) the instant it arrives, so every downstream piece of UI (strip, remove,
preview, announce) is the exact same code whether the image came from a clipboard paste, a typed/
pasted path, or a drop.

### `AttachmentsState` (per Session, alongside the existing draft/queue state)

```ts
interface AttachmentsState {
  images: PendingImageAttachment[];
  textChips: PendingTextChip[];
}
```

Not part of `SessionRuntime` (data-model.md, spec 001): attachments belong to the composer's current
draft, not to the Session's transcript or queue state, and the renderer never sends these pending
images to main except as the `images` array of one outgoing `chat.send` call (superseded, issue
#540, 2026-10-07: the quality-gate-era `queuedImages` resend mechanism described below is gone --
`chat.sendNow` now takes no `images` argument because OMP's own `promote_queued_message` moves a
queued message's existing attachments itself; see `contracts/ipc.md`).

## IPC surface change (`src/shared/ipc.ts`, `contracts/ipc.md`)

```ts
chat.send(sessionId: string, text: string, images?: ImageContent[]): Result<{ queued: boolean }>
// Superseded (issue #540, 2026-10-07): sendNow no longer returns `{ steered: boolean }` -- see
// specs/001-core-session-workspace/contracts/ipc.md "Chat" for the current `{ promoted: boolean }`
// signature.
chat.sendNow(sessionId: string, text: string): Result<{ steered: boolean }>

// New (#514/#432): the one shared main-process image-file reader. `path` is an absolute OS path
// (read directly, no worktree containment, FR-021) or a path relative to this Session's own
// worktree (resolved and contained via the existing `resolveInWorktree`, #610).
attachments.readImageFile(sessionId: string, path: string): Result<AttachmentImageFile>
// New (#432): renderer-local only, no IPC round trip -- the renderer-safe replacement for the
// removed `File.path` (Electron's own `webUtils.getPathForFile`), bridged through preload rather
// than imported from `electron` directly in a renderer file (see contracts/ipc.md for why).
attachments.getPathForFile(file: File): string
// New (#514): the Settings switch FR-024 adds, same immediate-apply shape every other Settings
// toggle in this app already uses (`settings.setShowSampleData`, spec 013).
settings.setDetectImagePathsOnPaste(enabled: boolean): Result<Settings>
```

New error codes: `unsupported-image-type`, `image-too-large` (contracts/ipc.md) -- both already
existed for `chat.send`'s own re-validation (FR-018) and are reused as-is by `readImageFile`
(FR-020), never a second pair of codes for the same two failure shapes.

## Changed entities

- **`Settings`** (specs/001 data-model.md) gains one field, `detectImagePathsOnPaste: boolean`
  (default `true`, FR-024) -- a plain immediate-apply toggle, the same migration shape
  `transcriptDisplay` (issue #457) already uses (lazy in-memory correction on a missing/malformed
  key, no raw/lazy-correction split needed). Persisted in `settings.json` like every other
  `Settings` field; everything else in this spec stays entirely in-memory (see below).

## No change to existing entities

- `Session`, `Repository`, `SessionRuntime`, `TranscriptItem`, `PendingRequest`,
  `ConversationInfo` (specs/001) are unchanged by this spec.
- `registry.json`, `processes.json` are unchanged. `settings.json` gains exactly the one new
  field above; nothing else in this spec is persisted across a restart -- a pending attachment on
  an in-progress draft is simply gone if Refract restarts, the same as the draft text itself
  already is.
