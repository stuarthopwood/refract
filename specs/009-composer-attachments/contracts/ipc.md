# Contract: composer attachments (renderer to main)

Extends `specs/001-core-session-workspace/contracts/ipc.md`. The `chat.*` methods below change,
and #514/#432 add two `attachments.*` methods plus one `settings.*` method; every other request
and event in that file is unaffected.

## Requests changed

### Chat (FR-006, FR-007, FR-013, FR-017, FR-018, FR-019)

| Method | Returns | Notes |
|---|---|---|
| `chat.send(sessionId, text, images?)` | `{ queued: boolean }` | `images?: ImageContent[]` (`src/shared/frames.ts`), each already validated by the renderer's own paste-time check (format supported or re-encoded to PNG, size under `MAX_IMAGE_INPUT_BYTES`). The handler re-validates every entry independently before building the outgoing `prompt`/`steer` command (constitution Principle V): an unsupported `mimeType` returns `unsupported-image-type`; a decoded size over `MAX_IMAGE_INPUT_BYTES` returns `image-too-large`. Both checks run before the existing `sessionId`/argument-shape checks' normal failure modes change in any way — they are additional, not replacements. Validation failure here means nothing was sent and the composer's pending attachments and draft text are left exactly as they were, so the developer can fix and retry. |
| `chat.sendNow(sessionId, text)` | `{ steered: boolean }` | **Remediation (quality gate, 2026-10-04): no `images?` parameter.** The original design forwarded a caller-supplied `images?` onto the `steer` command this builds from scratch; in practice this meant whatever images are pending in the composer *right now* (usually meant for a later, different message) went out on a resend of an *earlier* queued message, while that queued message's own real images were silently dropped (`remove_queued_message` removes them along with its text). `SessionAgent` now records a queued `prompt`'s own images (if any) at the moment `chat.send` queues it, keyed by the same exact text `remove_queued_message`/`steer` already match a queued chip by, and `sendNow` resends those … **Superseded (issue #540, 2026-10-07): `queuedImages` and the hand-made remove-then-steer this row describes are gone.** `sendNow` is now one atomic `promote_queued_message` call that moves the existing queued follow-up -- its own attachments included, with no reprocessing and no separate image-recording mechanism needed -- to the end of the steering queue, and returns `{ promoted: boolean }`, not `{ steered: boolean }`. See `specs/001-core-session-workspace/contracts/ipc.md` "Chat" for the current signature.

No other `chat.*` method changes. `chat.predictWord`/`chat.predictWordFeedback`, `chat.stop`,
`chat.removeQueued`, `chat.answer`, and `chat.commands` are unaffected by this spec.

### Attachments (new, #514/#432 FR-020, FR-021, FR-029)

| Method | Returns | Notes |
|---|---|---|
| `attachments.readImageFile(sessionId, path)` | `Result<AttachmentImageFile>` | The ONE shared main-process image-file reader #514 (paste/typed-path) and #432 (drag-and-drop) both call. `path` either an absolute OS path (read directly, realpath + regular-file check, no worktree containment -- FR-021) or a path relative to `sessionId`'s own worktree (resolved and contained via the existing `resolveInWorktree`, issue #610, the single reused containment surface). Rejects an unsafe token shape up front via `files.ts`'s existing `isUnsafeToken` (UNC/device paths, a colon other than a drive prefix, a reserved device name per segment -- exported for this reuse, never duplicated). Identifies the type purely by magic bytes (never the extension); enforces the existing `MAX_IMAGE_INPUT_BYTES` cap against the real on-disk size BEFORE ever reading the file, and a pixel-count cap (`MAX_IMAGE_PIXELS`, moved to `shared/images.ts` so this reader and the renderer's own re-encode path share one cap) against dimensions parsed straight from the image's own header bytes (no image-decoding library). Failure reasons reuse the two existing `chat.send` error codes below -- never a third/fourth code for the same two failure shapes. |
| `attachments.getPathForFile(file)` | `string` | Renderer-local only, no IPC round trip, no main-process involvement: bridges Electron's own `webUtils.getPathForFile` (the renderer-safe replacement for the removed `File.path`) through preload instead of importing `electron` directly in a renderer `.tsx` file. **Why bridged rather than imported directly**: `electron.d.ts` carries its own `/// <reference types="node" />`; once ANY renderer file imports from `'electron'`, that reference pulls Node's ambient `setTimeout` overload into the WHOLE `tsconfig.web.json` program, silently changing every other file's own `setTimeout(...): number` (DOM lib) return type to `NodeJS.Timeout` -- confirmed by a real typecheck run during this feature's own development (five unrelated files broke); routing the one call through preload (which already expects Node's ambient types, `tsconfig.node.json`) avoids this entirely. |

### Settings (new, #514 FR-024)

| Method | Returns | Notes |
|---|---|---|
| `settings.setDetectImagePathsOnPaste(enabled)` | `Result<Settings>` | Persists the whole `Settings` row, the same race-safety/migration shape `settings.setShowSampleData` (spec 013) already uses -- no raw/lazy-correction split needed (a plain immediate-apply boolean). Turns path-based image-attach detection off entirely on `false`; a pasted clipboard image itself (FR-001) is never affected. Default `true`. |

## New error codes

| Code | Meaning |
|---|---|
| `unsupported-image-type` | An entry in `images` has a `mimeType` outside `SUPPORTED_IMAGE_MIME_TYPES` (`image/png`, `image/jpeg`, `image/gif`, `image/webp`). The renderer's own paste-time re-encode (research.md Decision 7) means this should not normally be reachable from the UI; it exists as the main process's own independent gate (constitution Principle V), not as the primary user-facing rejection path. |
| `image-too-large` | An entry in `images` decodes to more than `MAX_IMAGE_INPUT_BYTES` (20 MiB). The renderer's own paste-time check (FR-003) is the primary path a developer actually sees; this is the same independent main-process gate as above. |

Both codes are returned the same way every other `chat.*` error code already is (`Result<T>`,
`{ ok: false, error: { code, message } }`), surfaced to the developer the same way any other failed
send is (spec's Edge Cases, FR-019) — never a silent drop of the draft or its other attachments.

## Unaffected surfaces

- `contracts/omp-usage.md` (spec 001): no new frame type, no new dialog classification. OMP's
  `prompt_result`, `agent_start`/`agent_end`, and `session_settled` frames are read by Refract
  exactly as spec 001 already implements them; this spec adds no new event Refract subscribes to.
  This spec therefore has no `omp-usage.md` of its own.
- Every event in spec 001's contracts/ipc.md (`session:status`, `transcript:patch`, `queue:update`,
  `request:pending`/`request:resolved`, `commands:update`, `settings:changed`, `ui:open-session`,
  `memory:warning`) is unchanged.
