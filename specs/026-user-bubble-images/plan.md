# Implementation Plan: Message images in the user bubble

**Spec**: `spec.md` (this folder). **Constitution**: Principle V (Tauri Security Baseline) is binding for the read path.

## Approach

1. **Rust, `src-tauri/src/omp/`**
   - New `transcript/user_images.rs`: `extract_images(parts) -> Vec<ImageRef>`. For each `image` part: `data` starting `blob:sha256:` with a 64-lowercase-hex tail becomes `ImageRef { id: <hash>, mimeType }` using the part's `mimeType`; no file IO at transcript-build time (a long history must not stall), so byteLength, width and height are absent and come from `images.get` when the tile resolves; otherwise inline base64 is validated with `images::validate_image_attachment`, stored in the bounded store, and the ref carries the deterministic id (`i-<fnv1a64 hex>-<len hex>`), mime, decoded length and header-parsed width and height.
   - New `omp/image_store.rs`: process-wide `Mutex` store (budget 96 MiB, 64 entries, oldest evicted), `put(bytes, mime) -> id`, `get(id)`.
   - New `omp/blob_store.rs`: `read_blob(hash) -> Result<(Vec<u8>, mime)>`: strict `^[0-9a-f]{64}$`, path = `<home>/.omp/agent/blobs/<hash>` then `<hash>.<ext>` for the four supported extensions, file metadata must be a regular file (no symlink follow beyond the folder: canonicalise and require the parent to equal the blob folder), size at most 20 MiB, magic bytes via `images::sniff_image_mime_type`, pixels at most 40 MP.
   - `TranscriptItem::User` gains `images` (serde `images`, skipped when empty). `file_attachment_markers::build_user_item` takes the content parts and fills it; the two call sites in `transcript.rs` only pass `parts`.
2. **IPC**: new `ipc/images.rs` registering `images.get` (args: `sessionId`, `imageId`): validates the id shape (hash or `i-` form), returns `{ dataUrl, mimeType, byteLength, width, height }` or error code `image-unavailable`. The data URL is `data:<mime>;base64,...` built by `images::base64_encode`. Contract in `src/shared/ipc-images.ts`; bridge entry in `src/tauri-bridge/index.ts`; request name in `ipc.ts`.
3. **Renderer**
   - `src/shared/model.ts`: `TranscriptImageRef` type and `images?` on the `user` item.
   - `components/` (shared): `MessageImageGrid` (tiles, responsive grid, `+N`, placeholder) and the generalised `ImagePreviewModal` (images array, initial index, next and previous, lazy resolve) moved to or re-exported from `src/renderer/components/`; the composer's `AttachmentStrip` keeps using it.
   - `lib/messageImageCache.ts`: small LRU (about 16 entries) of resolved data URLs plus in-flight de-duplication.
   - `UserMessageRow.tsx` renders the grid above the text; a message with no text renders no empty text block.
4. Docs: `CONTEXT.md` (done), `docs/design/components.md` gains the two components, `docs/PLAN.md` row 21 status.

## File-size notes

`transcript.rs` stays at or under its 1813 baseline (net change: two argument swaps and one field, offset by moving none in). Everything else is new files under 600 lines. `ipc.ts`, `model.ts` (656 baseline) grow by under 10 lines each only if the baseline allows; otherwise the type moves to a new `model-images.ts`.

## Risks

- Viewing an image the history lists past the four visible tiles: the viewer resolves by id on demand, so all N open.
- Blob folder is OMP's private layout; any mismatch yields the placeholder, never an error.
- Eviction from the live store loses a live image until reload (blob then exists); accepted.
