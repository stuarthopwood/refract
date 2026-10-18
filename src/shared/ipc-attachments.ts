// The `attachments.*` IPC contract, split into its own file to keep `ipc.ts` at its existing
// file-size baseline (issue #806, `scripts/check-file-size.mjs`) -- pure extraction, no existing
// export moves beyond this one sub-interface, same precedent `ipc-model.ts` already set for
// `ModelApi`.

import type { Result, Unsubscribe } from './ipc';
import type { SupportedImageMimeType } from './frames';

/** #514/#432: `attachments.readImageFile`'s success payload -- the exact fields
 * `PendingImageAttachment` (renderer `attachments.ts`) needs to build the same thumbnail/preview
 * UI a pasted clipboard image already gets; deliberately no path or other file metadata. */
export interface AttachmentImageFile {
  mimeType: SupportedImageMimeType;
  base64: string;
  byteLength: number;
}

/** #926: `attachments.readFile`'s success payload -- classifies a non-image path (or folder)
 * into either `inline` (a text file up to the 256 KB cap, decoded verbatim) or `path` (binary,
 * over the cap, or a folder: too large/unsafe to inline, sent as its own absolute path instead
 * for the agent to read with its own tools). Unlike `AttachmentImageFile`, this DOES carry the
 * resolved path -- the whole point of the `path` case is that the path itself is the payload. */
export type AttachmentFileRead =
  | { kind: 'inline'; path: string; name: string; byteLength: number; text: string }
  | { kind: 'path'; path: string; name: string; byteLength: number; isDirectory: boolean };

/** `RefractApi.attachments`: every reader/picker the composer's Attach button, drag-and-drop, and
 * clipboard paste share, plus the Tauri-only native drag-drop event. */
export interface AttachmentsApi {
  /** #514/#432: the one shared main-process image-file reader both features use. `path` is
   * either an absolute OS path (Explorer "Copy as path", a screenshot tool, `webUtils.
   * getPathForFile` on a dropped `File`) or a path relative to this Session's own worktree;
   * this is a USER-initiated read (a paste, a confirmed typed path, or a drag-drop), never
   * agent/tool/model-authored text -- an absolute token is NOT required to stay inside the
   * worktree (unlike `sessions.revealFile`/the file explorer), matching the trust level the
   * existing repository folder-picker already grants a user's own absolute path choice. Rejects
   * UNC/device paths, resolves symlinks/junctions via `realpath`, requires a regular file,
   * identifies the type purely by its magic bytes (never the extension, FR-003's own rule),
   * and enforces the same byte-size and pixel caps `buildImageAttachment` (renderer) checks for
   * a pasted clipboard image -- constitution V: the renderer's own check is never trusted
   * alone. Never returns the resolved path or any other file metadata to the renderer. */
  readImageFile(sessionId: string, path: string): Promise<Result<AttachmentImageFile>>;
  /** #926: classifies a non-image path (or folder) for the "attach any file" feature -- text
   * up to 256 KB inlined verbatim (`kind: 'inline'`), everything else (binary, over the cap,
   * or a folder) sent as its own resolved absolute path (`kind: 'path'`) for the agent to read
   * with its own tools. Same path resolution/symlink-safety rules as `readImageFile` above
   * (`path` is a USER-initiated absolute OS path or a worktree-relative one); unlike
   * `readImageFile`, this DOES return the resolved path -- that path IS the payload for the
   * `path` case, not metadata to withhold. */
  readFile(sessionId: string, path: string): Promise<Result<AttachmentFileRead>>;
  /** #926: the Attach button's native multi-file picker (no extension filter -- "any file
   * type" is the point of this feature), the same `tauri-plugin-dialog` pattern
   * `repositories.pickFolder` already uses. Real absolute OS paths, routed through
   * `readImageFile`/`readFile` by the renderer exactly like a dropped or typed path. An empty
   * array means the dialog was cancelled, never an error. */
  pickFiles(): Promise<Result<string[]>>;
  /** #432: the renderer-safe replacement for Electron's own `webUtils.getPathForFile`
   * (bridged here, not imported from `electron` in a renderer file, to avoid pulling its
   * ambient Node `setTimeout` override into the whole web program). Optional (issue #793):
   * absent in the Tauri build -- the standard `File` API exposes no OS path, and its own
   * `drop` DOM event never reaches the page either; `onFileDrop` below is the replacement. */
  getPathForFile?(file: File): string;
  /** Tauri build only (issue #793): real OS paths from Tauri's own native drag-drop handler,
   * which swallows the HTML5 `drop` event (`dragenter`/`dragover`/`dragleave` still fire).
   * `position` is physical pixels from the webview's top-left corner. Absent in Electron. */
  onFileDrop?(handler: (event: { paths: string[]; position: { x: number; y: number } }) => void): Unsubscribe;
}
