// Windows notifications (tasks.md T038, FR-027): a Notification only when no Pinion window has
// OS focus and only when a Session becomes `needs-you`, or finishes (`working` -> `idle`).
// Clicking focuses the window and emits `ui:open-session`. Nothing else notifies. Dev mode must
// call `app.setAppUserModelId` first (already done in `index.ts`) or notifications may not show.

import { BrowserWindow, Notification } from 'electron';
import { IPC_EVENTS } from '../shared/ipc';
import type { SessionStatus } from '../shared/model';
import type { SessionManager } from './SessionManager';

export function registerNotifications(manager: SessionManager, getWindow: () => BrowserWindow | undefined): void {
  const lastStatus = new Map<string, SessionStatus>();

  manager.onEvent((event) => {
    if (event.type !== 'status') return;
    const { sessionId, status } = event.payload;
    const previous = lastStatus.get(sessionId);
    lastStatus.set(sessionId, status);

    const window = getWindow();
    if (window && !window.isDestroyed() && window.isFocused()) return;

    const becameNeedsYou = status === 'needs-you' && previous !== 'needs-you';
    const finished = previous === 'working' && status === 'idle';
    if (!becameNeedsYou && !finished) return;

    const notification = new Notification({
      title: 'Pinion',
      body: becameNeedsYou ? 'A Session needs your input.' : 'A Session finished.',
    });
    notification.on('click', () => {
      const clicked = getWindow();
      if (!clicked || clicked.isDestroyed()) return;
      if (clicked.isMinimized()) clicked.restore();
      clicked.focus();
      clicked.webContents.send(IPC_EVENTS.UI_OPEN_SESSION, { sessionId });
    });
    notification.show();
  });
}
