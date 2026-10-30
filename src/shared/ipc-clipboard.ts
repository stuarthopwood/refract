// The `clipboard.*` IPC contract, split out to keep `ipc.ts` at its file-size baseline (#806).

import type { Result } from './ipc';

export interface ClipboardApi {
  /** Fallback for a sandboxed renderer where `navigator.clipboard.writeText` is refused. */
  writeText(text: string): Promise<Result<void>>;
  /** Fallback for `navigator.clipboard.readText` (composer menu Paste, #471). */
  readText(): Promise<Result<string>>;
}
