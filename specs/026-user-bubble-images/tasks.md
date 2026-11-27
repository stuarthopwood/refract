# Tasks: Message images in the user bubble

Order matters; each task commits on its own. No new tests (prototyping phase); existing tests stay green.

- [ ] T001 Rust: `omp/image_store.rs` (bounded store, deterministic ids). FR-005
- [ ] T002 Rust: `omp/blob_store.rs` (strict hash, fixed folder, caps, magic bytes). FR-004
- [ ] T003 Rust: `transcript/user_images.rs` + `TranscriptItem::User.images`; `build_user_item` takes parts; both `transcript.rs` call sites updated. FR-001, FR-002
- [ ] T004 Rust: `ipc/images.rs` `images.get`, registered in `ipc/mod.rs`. FR-003
- [ ] T005 Shared: `TranscriptImageRef` + `images?` on the user item; `ipc-images.ts` contract, `ipc.ts` request name, `tauri-bridge` entry. FR-001, FR-003
- [ ] T006 Renderer: `lib/messageImageCache.ts` (LRU, in-flight de-dup). FR-006
- [ ] T007 Renderer: shared `ImagePreviewModal` generalised (images array, lazy resolve, next/previous, arrow keys, focus return) in `components/`; `AttachmentStrip` adapted. FR-008
- [ ] T008 Renderer: shared `MessageImageGrid` in `components/`; `UserMessageRow` renders it; image-only message has no empty text. FR-006, FR-007, FR-009, FR-010
- [ ] T009 Docs: `docs/design/components.md`, `docs/PLAN.md` row 21. 
- [ ] T010 Verify: `pnpm typecheck`, `pnpm test`, then (build slot) `pnpm ci:local` and the live check at 320 px and wide with screenshots. SC-001..SC-004

## Phase: Convergence (chat transcript polish, epic #2222)

- [x] T-C1855 (#1855) Renderer: `lib/imageSize.ts` (`maxDrawnSize`, `tileImageFit`, `widthWithinHeight`) and `hooks/useDevicePixelRatio.ts`; `ImageThumbnail` draws a single image, its placeholder and a fitting grid tile no larger than its pixel size over the display scale. FR-011
- [x] T-C1254a (#1254) Renderer: `ImageViewer` sizes to the image, focuses the dialog on open, 44 px Previous and Next through `IconButton`, `preventDefault` on arrow keys, distinct alt; the verify-513 scripts follow the new alt. FR-012
- [x] T-C1254b (#1254) Renderer: `messageImageTileLabel` names the "+N" tile; an unavailable "+N" tile is a button; grid tiles reserve no aspect ratio; named class constants, `gap-2`, group focus ring, placeholder contrast, `mimeType` in the composer preview. FR-013
