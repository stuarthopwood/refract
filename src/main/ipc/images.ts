// Issue #513 (contracts: this file's own `IPC_REQUESTS.IMAGES_GET`): the one IPC channel that
// turns a `TranscriptImageRef.id` into a renderable image, following `attachments.ts`'s own
// registration pattern exactly (shape-check every argument off the wire, `Result<T>`, the shared
// `invalidArgument`/`notFound` helpers).
import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { Result, ResolvedImage } from '../../shared/ipc';
import { resolveImage } from '../omp/blobStore';
import type { SessionManager } from '../SessionManager';
import { invalidArgument, notFound } from './util';

const MAX_SESSION_ID_LENGTH = 256; // matches attachments.ts's own constant
// Generous cap for an arbitrary OMP-echoed `mimeType` string (`OmpImagePart`'s own doc comment:
// OMP may send anything) -- only ever compared against the fixed 4-entry supported list, never
// used to build a path, so this exists purely to refuse an absurd-length argument early.
const MAX_MIME_TYPE_LENGTH = 64;

export function registerImagesIpc(manager: SessionManager): void {
  ipcMain.handle(
    IPC_REQUESTS.IMAGES_GET,
    async (_event, sessionId: unknown, imageId: unknown, mimeType: unknown, size: unknown): Promise<Result<ResolvedImage>> => {
      if (typeof sessionId !== 'string' || typeof imageId !== 'string' || typeof mimeType !== 'string') {
        return invalidArgument(`${IPC_REQUESTS.IMAGES_GET} expects (sessionId, imageId, mimeType) strings`);
      }
      if (sessionId.length > MAX_SESSION_ID_LENGTH || mimeType.length > MAX_MIME_TYPE_LENGTH) {
        return invalidArgument(`${IPC_REQUESTS.IMAGES_GET} rejected an oversized argument`);
      }
      if (size !== 'thumbnail' && size !== 'full') {
        return invalidArgument(`${IPC_REQUESTS.IMAGES_GET} expects size 'thumbnail' or 'full'`);
      }
      if (!manager.registry.getSession(sessionId)) return notFound(`Session not found: ${sessionId}`);
      const cached = manager.getAgent(sessionId)?.getCachedImage(imageId);
      const resolution = await resolveImage(imageId, mimeType, size, cached);
      if (!resolution.ok) {
        // Issue #513 (data-model.md): both failure codes collapse to the SAME renderer-facing
        // placeholder ("Image no longer available") -- neither a malformed id/mimeType nor a
        // missing/invalid blob is ever shown as anything more specific, so a caller cannot use
        // the distinction to probe which blob hashes exist on disk.
        return resolution.code === 'not-found'
          ? notFound('Image no longer available')
          : invalidArgument('Image no longer available');
      }
      return { ok: true, value: resolution.value };
    },
  );
}
