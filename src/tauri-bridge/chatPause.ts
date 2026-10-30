import { IPC_REQUESTS } from '../shared/ipc'
import type { Result } from '../shared/ipc'
import type { ChatPauseApi } from '../shared/ipc-pause'

export function chatPauseBridge(
  request: <T>(channel: string, ...args: unknown[]) => Promise<Result<T>>
): ChatPauseApi {
  return {
    pause: (sessionId) => request<void>(IPC_REQUESTS.CHAT_PAUSE, sessionId),
    resume: (sessionId) => request<void>(IPC_REQUESTS.CHAT_RESUME, sessionId),
    pauseAll: () => request<{ count: number }>(IPC_REQUESTS.CHAT_PAUSE_ALL),
    resumeAll: () => request<{ count: number; failed: number }>(IPC_REQUESTS.CHAT_RESUME_ALL)
  }
}
