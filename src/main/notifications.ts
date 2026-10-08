// Windows notifications (tasks.md T038, FR-027): a Notification only when no Refract window has
// OS focus and only when a Session becomes `needs-you`, or finishes (`working` -> `idle`).
// Clicking focuses the window and emits `ui:open-session`. Nothing else notifies.
// `app.setAppUserModelId` (called unconditionally in `index.ts`, not just in dev) must run before
// this, or Windows may resolve the toast to Electron's own identity instead of Refract's.
// Issue #494: passing `icon` below (the same dev-only `build/icon.ico` the window itself uses,
// `WINDOW_ICON_PATH` from `index.ts`) fixes the toast's own icon -- live-verified on a scratch
// Electron instance (main-process `Notification` driven directly over the Node inspector
// protocol, `com.stuarthopwood.refract` already set): the body icon changed from a generic grey
// icon to Refract's logo. The toast's *header* still read "Electron" in that test, because
// Windows resolves an AppUserModelId's display name from a registered Start Menu shortcut, which
// this dev launch method does not have -- a known limitation the issue itself names as
// unresolved for "fully-branded notifications" (out of this fix's scope; see the PR body).

import { app, BrowserWindow, Notification, nativeImage } from 'electron';
import { IPC_EVENTS } from '../shared/ipc';
import type { SessionStatus } from '../shared/model';
import type { SessionManager } from './SessionManager';

export function registerNotifications(
  manager: SessionManager,
  getWindow: () => BrowserWindow | undefined,
  iconPath: string
): void {
  const lastStatus = new Map<string, SessionStatus>();
  // Computed once, gated the same way index.ts's setIcon call is (same WINDOW_ICON_PATH): a
  // packaged launch never pays for a createFromPath read of a path it already knows does not
  // exist (spec 006 ships the packaged icon via electron-builder's `win.icon` instead, not this
  // file's `iconPath`).
  const icon = app.isPackaged ? undefined : nativeImage.createFromPath(iconPath);

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

    // T057: read the live display name at fire time (never cached), so a rename shows in the
    // very next notification with no extra plumbing -- the registry is the source of truth and
    // this already runs on the main process's own event loop, after the rename IPC has resolved.
    const name = manager.registry.getSession(sessionId)?.name ?? 'A Session';
    const notification = new Notification({
      title: 'Refract',
      body: becameNeedsYou ? `${name} needs your input.` : `${name} finished.`,
      icon,
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
