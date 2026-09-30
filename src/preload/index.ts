import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC_EVENTS, IPC_REQUESTS } from '../shared/ipc'
import type {
  ChatAnswer,
  LowMemoryWarning,
  PinionApi,
  Readiness,
  Result,
  SessionSnapshot,
  SessionStatusEvent,
  SessionSummary,
  SlashCommand,
  TranscriptOp,
  Unsubscribe
} from '../shared/ipc'
import type { ConversationInfo, PendingRequest, Repository, Session, Settings } from '../shared/model'
import type { PinionScaffoldCheckApi } from './api'

// window.pinion: the sole renderer-to-main bridge (contracts/ipc.md). The renderer never sees
// ipcRenderer or a raw channel string; every method below is a fixed, typed call.

// Every request channel answers with a Result<T>; main is trusted to shape it correctly, so the
// cast below is the one place that trust is spent.
function request<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<Result<T>>
}

// Every event channel is main-pushed, no-reply; wraps ipcRenderer.on/removeListener as a typed
// subscribe-and-forget with an unsubscribe function, per the Unsubscribe contract.
function on<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const pinion: PinionApi = {
  readiness: {
    check: () => request<Readiness>(IPC_REQUESTS.READINESS_CHECK)
  },

  repositories: {
    list: () => request<Repository[]>(IPC_REQUESTS.REPOSITORIES_LIST),
    add: (path) => request<Repository>(IPC_REQUESTS.REPOSITORIES_ADD, path),
    remove: (id) => request<void>(IPC_REQUESTS.REPOSITORIES_REMOVE, id),
    branches: (id) => request<{ branches: string[]; default: string }>(IPC_REQUESTS.REPOSITORIES_BRANCHES, id)
  },

  sessions: {
    list: () => request<SessionSummary[]>(IPC_REQUESTS.SESSIONS_LIST),
    create: (input) => request<Session>(IPC_REQUESTS.SESSIONS_CREATE, input),
    rename: (id, name) => request<void>(IPC_REQUESTS.SESSIONS_RENAME, id, name),
    open: (id) => request<SessionSnapshot>(IPC_REQUESTS.SESSIONS_OPEN, id),
    archive: (id) => request<void>(IPC_REQUESTS.SESSIONS_ARCHIVE, id),
    restore: (id) => request<void>(IPC_REQUESTS.SESSIONS_RESTORE, id),
    deleteCheck: (id) =>
      request<{ uncommittedFiles: number; unpushedCommits: number; hasUpstream: boolean }>(
        IPC_REQUESTS.SESSIONS_DELETE_CHECK,
        id
      ),
    delete: (id, options) => request<void>(IPC_REQUESTS.SESSIONS_DELETE, id, options),
    recreateWorktree: (id) => request<void>(IPC_REQUESTS.SESSIONS_RECREATE_WORKTREE, id),
    recover: (id) => request<SessionSnapshot>(IPC_REQUESTS.SESSIONS_RECOVER, id),
    stopAgent: (sessionId) => request<void>(IPC_REQUESTS.SESSIONS_STOP_AGENT, sessionId)
  },

  conversations: {
    list: (sessionId) => request<ConversationInfo[]>(IPC_REQUESTS.CONVERSATIONS_LIST, sessionId),
    startNew: (sessionId) => request<SessionSnapshot>(IPC_REQUESTS.CONVERSATIONS_START_NEW, sessionId),
    open: (sessionId, file) => request<SessionSnapshot>(IPC_REQUESTS.CONVERSATIONS_OPEN, sessionId, file)
  },

  chat: {
    send: (sessionId, text) => request<{ queued: boolean }>(IPC_REQUESTS.CHAT_SEND, sessionId, text),
    stop: (sessionId) => request<void>(IPC_REQUESTS.CHAT_STOP, sessionId),
    removeQueued: (sessionId, text) => request<{ removed: boolean }>(IPC_REQUESTS.CHAT_REMOVE_QUEUED, sessionId, text),
    sendNow: (sessionId, text) => request<{ steered: boolean }>(IPC_REQUESTS.CHAT_SEND_NOW, sessionId, text),
    answer: (sessionId, requestId, answer: ChatAnswer) =>
      request<void>(IPC_REQUESTS.CHAT_ANSWER, sessionId, requestId, answer),
    commands: (sessionId) => request<SlashCommand[]>(IPC_REQUESTS.CHAT_COMMANDS, sessionId)
  },

  settings: {
    get: () => request<Settings>(IPC_REQUESTS.SETTINGS_GET),
    setApprovalMode: (mode) => request<Settings>(IPC_REQUESTS.SETTINGS_SET_APPROVAL_MODE, mode)
  },

  onSessionStatus: (handler) => on<SessionStatusEvent>(IPC_EVENTS.SESSION_STATUS, handler),
  onSessionListChanged: (handler) => on<void>(IPC_EVENTS.SESSION_LIST_CHANGED, handler),
  onTranscriptPatch: (handler) => on<{ sessionId: string; ops: TranscriptOp[] }>(IPC_EVENTS.TRANSCRIPT_PATCH, handler),
  onQueueUpdate: (handler) =>
    on<{ sessionId: string; followUp: string[]; steering: string[] }>(IPC_EVENTS.QUEUE_UPDATE, handler),
  onRequestPending: (handler) =>
    on<{ sessionId: string; request: PendingRequest }>(IPC_EVENTS.REQUEST_PENDING, handler),
  onRequestResolved: (handler) => on<{ sessionId: string; requestId: string }>(IPC_EVENTS.REQUEST_RESOLVED, handler),
  onCommandsUpdate: (handler) =>
    on<{ sessionId: string; commands: SlashCommand[] }>(IPC_EVENTS.COMMANDS_UPDATE, handler),
  onSettingsChanged: (handler) => on<Settings>(IPC_EVENTS.SETTINGS_CHANGED, handler),
  onUiOpenSession: (handler) => on<{ sessionId: string }>(IPC_EVENTS.UI_OPEN_SESSION, handler),
  onMemoryWarning: (handler) => on<LowMemoryWarning>(IPC_EVENTS.MEMORY_WARNING, handler)
}

contextBridge.exposeInMainWorld('pinion', pinion)

// Scaffold-verification API for the T003 sandbox gate: proves the preload script actually runs
// sandboxed and that contextBridge crosses the isolated world into the renderer. Kept until the
// parent task removes it.
const pinionScaffoldCheck: PinionScaffoldCheckApi = {
  ping: () => ({
    message: 'pong',
    sandboxed: process.sandboxed,
    contextIsolated: process.contextIsolated
  })
}

contextBridge.exposeInMainWorld('pinionScaffoldCheck', pinionScaffoldCheck)
