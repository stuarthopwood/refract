import { Channel } from '@tauri-apps/api/core'
import { IPC_EVENTS, IPC_REQUESTS } from '../shared/ipc'
import type { Result } from '../shared/ipc'
import type { TabState, TerminalApi, TerminalTabStateEvent } from '../shared/ipc-terminal'

/** The one place a Tauri `Channel` is built; the renderer never imports it elsewhere (contracts/terminal-ipc.md). */
export function terminalBridge(
  request: <T>(channel: string, ...args: unknown[]) => Promise<Result<T>>,
  on: <T>(channel: string, handler: (payload: T) => void) => () => void,
  makeChannel: () => Channel<ArrayBuffer> = () => new Channel<ArrayBuffer>()
): TerminalApi {
  return {
    list: (sessionId) => request(IPC_REQUESTS.TERMINAL_LIST, sessionId),
    create: (sessionId, cols, rows) => request(IPC_REQUESTS.TERMINAL_CREATE, sessionId, cols, rows),
    attach: (sessionId, tabId, cols, rows, onFrame) => {
      const channel = makeChannel()
      channel.onmessage = onFrame
      return request<{ state: TabState }>(IPC_REQUESTS.TERMINAL_ATTACH, sessionId, tabId, channel, cols, rows)
    },
    detach: (tabId) => request(IPC_REQUESTS.TERMINAL_DETACH, tabId),
    input: (tabId, data) => request(IPC_REQUESTS.TERMINAL_INPUT, tabId, data),
    resize: (tabId, cols, rows) => request(IPC_REQUESTS.TERMINAL_RESIZE, tabId, cols, rows),
    ack: (tabId, bytes) => request(IPC_REQUESTS.TERMINAL_ACK, tabId, bytes),
    close: (tabId, force) => request(IPC_REQUESTS.TERMINAL_CLOSE, tabId, force),
    rename: (tabId, name) => request(IPC_REQUESTS.TERMINAL_RENAME, tabId, name),
    restart: (tabId) => request(IPC_REQUESTS.TERMINAL_RESTART, tabId),
    readOutput: (tabId, mode) => request(IPC_REQUESTS.TERMINAL_READ_OUTPUT, tabId, mode),
    onTabState: (handler) => on<TerminalTabStateEvent>(IPC_EVENTS.TERMINAL_TAB_STATE, handler)
  }
}
