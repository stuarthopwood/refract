// IPC handler for `clipboard.writeText` (contracts/ipc.md "Clipboard", T069): the fallback a
// Copy-path button uses when the sandboxed renderer's own `navigator.clipboard.writeText` is
// refused (`session.setPermissionRequestHandler` in `index.ts` denies every permission request).
// `electron.clipboard` is a main-process API and needs no such permission.

import { clipboard, ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import { invalidArgument } from './util';

export function registerClipboard(): void {
  ipcMain.handle(IPC_REQUESTS.CLIPBOARD_WRITE_TEXT, async (_event, text: unknown) => {
    if (typeof text !== 'string') return invalidArgument(`${IPC_REQUESTS.CLIPBOARD_WRITE_TEXT} expects a string`);
    try {
      clipboard.writeText(text);
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: { code: 'clipboard-failed', message: err instanceof Error ? err.message : String(err) } };
    }
  });
}
