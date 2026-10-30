// The `clipboard.*` IPC contract, split out to keep `ipc.ts` at its file-size baseline (#806).

import type { Result } from './ipc';

export interface ClipboardApi {
  /** Fallback for a sandboxed renderer where `navigator.clipboard.writeText` is refused. */
  writeText(text: string): Promise<Result<void>>;
  /** Fallback for `navigator.clipboard.readText` (composer menu Paste, #471). */
  readText(): Promise<Result<string>>;
  /** Puts a PNG (base64, no data-URL prefix) on the clipboard as an image (Mermaid Copy as image, #471). */
  writeImage(pngBase64: string): Promise<Result<void>>;
  /** Asks for a path with a native Save dialog and writes the PNG there; resolves to the path, or null when cancelled. */
  saveImage(pngBase64: string, suggestedName: string): Promise<Result<string | null>>;
}
