
import type { Result, Unsubscribe } from './ipc';
import type { SupportedImageMimeType } from './frames';

/** `attachments.readImageFile`'s success payload. */
export interface AttachmentImageFile {
  mimeType: SupportedImageMimeType;
  base64: string;
  byteLength: number;
}

/** `attachments.readFile`'s success payload. */
export type AttachmentFileRead =
  | { kind: 'inline'; path: string; name: string; byteLength: number; text: string }
  | { kind: 'path'; path: string; name: string; byteLength: number; isDirectory: boolean };

/** `RefractApi.attachments`: every reader/picker the composer's Attach button, drag-and-drop, and clipboard paste share. */
export interface AttachmentsApi {
  /** Never returns the resolved path or any other file metadata to the renderer. */
  readImageFile(sessionId: string, path: string): Promise<Result<AttachmentImageFile>>;
  readFile(sessionId: string, path: string): Promise<Result<AttachmentFileRead>>;
  /** An empty array means the dialog was cancelled, never an error. */
  pickFiles(sessionId: string): Promise<Result<string[]>>;
  recordDroppedPaths(sessionId: string, paths: string[]): Promise<Result<void>>;
  getPathForFile?(file: File): string;
  onFileDrop?(handler: (event: { paths: string[]; position: { x: number; y: number } }) => void): Unsubscribe;
}
