# Contract: composer attachments (renderer to main)

Extends `specs/001-core-session-workspace/contracts/ipc.md`. Only the two methods below change;
every other request and event in that file is unaffected.

## Requests changed

### Chat (FR-006, FR-007, FR-013, FR-017, FR-018, FR-019)

| Method | Returns | Notes |
|---|---|---|
| `chat.send(sessionId, text, images?)` | `{ queued: boolean }` | `images?: ImageContent[]` (`src/shared/frames.ts`), each already validated by the renderer's own paste-time check (format supported or re-encoded to PNG, size under `MAX_IMAGE_INPUT_BYTES`). The handler re-validates every entry independently before building the outgoing `prompt`/`steer` command (constitution Principle V): an unsupported `mimeType` returns `unsupported-image-type`; a decoded size over `MAX_IMAGE_INPUT_BYTES` returns `image-too-large`. Both checks run before the existing `sessionId`/argument-shape checks' normal failure modes change in any way — they are additional, not replacements. Validation failure here means nothing was sent and the composer's pending attachments and draft text are left exactly as they were, so the developer can fix and retry. |
| `chat.sendNow(sessionId, text)` | `{ steered: boolean }` | **Remediation (quality gate, 2026-10-04): no `images?` parameter.** The original design forwarded a caller-supplied `images?` onto the `steer` command this builds from scratch; in practice this meant whatever images are pending in the composer *right now* (usually meant for a later, different message) went out on a resend of an *earlier* queued message, while that queued message's own real images were silently dropped (`remove_queued_message` removes them along with its text). `SessionAgent` now records a queued `prompt`'s own images (if any) at the moment `chat.send` queues it, keyed by the same exact text `remove_queued_message`/`steer` already match a queued chip by, and `sendNow` resends those … **Superseded (issue #540, 2026-10-07): `queuedImages` and the hand-made remove-then-steer this row describes are gone.** `sendNow` is now one atomic `promote_queued_message` call that moves the existing queued follow-up -- its own attachments included, with no reprocessing and no separate image-recording mechanism needed -- to the end of the steering queue, and returns `{ promoted: boolean }`, not `{ steered: boolean }`. See `specs/001-core-session-workspace/contracts/ipc.md` "Chat" for the current signature.

No other `chat.*` method changes. `chat.predictWord`/`chat.predictWordFeedback`, `chat.stop`,
`chat.removeQueued`, `chat.answer`, and `chat.commands` are unaffected by this spec.

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
