// Registers every `contracts/ipc.md` request channel (`IPC_REQUESTS`) with `ipcMain.handle` and
// forwards `SessionManager` events to the renderer on the matching `IPC_EVENTS` channel
// (tasks.md T017). Each area file (`readiness.ts`, `repositories.ts`, `sessions.ts`,
// `conversations.ts`, `chat.ts`, `settings.ts`, `clipboard.ts`) registers its own channels; this
// file only wires them together and owns the manager-to-window event forwarding.

import type { BrowserWindow, Menu } from 'electron';
import { IPC_EVENTS } from '../../shared/ipc';
import type { ManagerEvent, SessionManager } from '../SessionManager';
import { registerAccounts } from './accounts';
import { registerChat } from './chat';
import { registerClipboard } from './clipboard';
import { registerConversations } from './conversations';
import { registerFileExplorer } from './fileExplorer';
import { registerFilesIpc } from './files';
import { registerModelRoles } from './modelRoles';
import { registerReadiness } from './readiness';
import { registerPullRequests } from './pullRequests';
import { registerRepositories } from './repositories';
import { registerSessions } from './sessions';
import { registerSideChat } from './side-chat';
import { registerSettings } from './settings';
import { registerTheme } from './theme';
import { registerWindow } from './window';

export function registerIpc(manager: SessionManager, getWindow: () => BrowserWindow | undefined, appMenu: Menu): void {
  registerReadiness();
  registerAccounts(manager, getWindow);
  registerRepositories(manager, getWindow);
  registerSessions(manager);
  registerFilesIpc(manager);
  registerFileExplorer(manager, getWindow);
  registerPullRequests(manager);
  registerConversations(manager);
  registerChat(manager);
  registerSideChat(manager);
  registerSettings(manager, getWindow);
  registerModelRoles();
  registerTheme(manager, getWindow);
  registerClipboard();
  registerWindow(appMenu, getWindow);

  manager.onEvent((event) => forwardEvent(event, getWindow));
}

/** Never throws: a destroyed or not-yet-created window simply drops the event. */
function forwardEvent(event: ManagerEvent, getWindow: () => BrowserWindow | undefined): void {
  try {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    switch (event.type) {
      case 'status':
        window.webContents.send(IPC_EVENTS.SESSION_STATUS, event.payload);
        return;
      case 'patch':
        window.webContents.send(IPC_EVENTS.TRANSCRIPT_PATCH, event.payload);
        return;
      case 'queue':
        window.webContents.send(IPC_EVENTS.QUEUE_UPDATE, event.payload);
        return;
      case 'request':
        window.webContents.send(IPC_EVENTS.REQUEST_PENDING, event.payload);
        return;
      case 'requestResolved':
        window.webContents.send(IPC_EVENTS.REQUEST_RESOLVED, event.payload);
        return;
      case 'commands':
        window.webContents.send(IPC_EVENTS.COMMANDS_UPDATE, event.payload);
        return;
      case 'readout':
        window.webContents.send(IPC_EVENTS.READOUT_UPDATE, event.payload);
        return;
      case 'subagents':
        window.webContents.send(IPC_EVENTS.SUBAGENTS_UPDATE, event.payload);
        return;
      case 'subagentPatch':
        window.webContents.send(IPC_EVENTS.SUBAGENT_PATCH, event.payload);
        return;
      case 'sideChatPatch':
        window.webContents.send(IPC_EVENTS.SIDE_CHAT_PATCH, event.payload);
        return;
      case 'sideChatInterrupted':
        window.webContents.send(IPC_EVENTS.SIDE_CHAT_INTERRUPTED, event.payload);
        return;
      case 'sideChatConversationChanged':
        window.webContents.send(IPC_EVENTS.SIDE_CHAT_CONVERSATION_CHANGED, event.payload);
        return;
      case 'list-changed':
        window.webContents.send(IPC_EVENTS.SESSION_LIST_CHANGED);
        return;
    }
  } catch (err) {
    console.error('registerIpc: failed to forward a manager event to the renderer', err);
  }
}
