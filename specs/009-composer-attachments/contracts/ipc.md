# Contract: composer attachments (renderer to main)

Extends `specs/001-core-session-workspace/contracts/ipc.md`. Only the two methods below change;
every other request and event in that file is unaffected.

## Requests changed

### Chat (FR-006, FR-007, FR-013, FR-017, FR-018, FR-019)

| Method | Returns | Notes |
|---|---|---|
| `chat.send(sessionId, text, images?)` | `{ queued: boolean }` | `images?: ImageContent[]` (`src/shared/frames.ts`), each already validated by the renderer's own paste-time check (format supported or re-encoded to PNG, size under `MAX_IMAGE_INPUT_BYTES`). The handler re-validates every entry independently before building the outgoing `prompt`/`steer` command (constitution Principle V): an unsupported `mimeType` returns `unsupported-image-type`; a decoded size over `MAX_IMAGE_INPUT_BYTES` returns `image-too-large`. Both checks run before the existing `sessionId`/argument-shape checks' normal failure modes change in any way — they are additional, not replacements. Validation failure here means nothing was sent and the composer's pending attachments and draft text are left exactly as they were, so the developer can fix and retry. |
| `chat.sendNow(sessionId, text, images?)` | `{ steered: boolean }` | Same `images?` parameter and the same two new error codes as `chat.send`, applied before the existing `remove_queued_message` then `steer` sequence (spec 001 tasks.md T024) builds its `steer` command with `images` set. |

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
