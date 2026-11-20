import type { Result } from '../shared/ipc'
import { IPC_CHECKLIST_EVENTS, IPC_CHECKLIST_REQUESTS } from '../shared/ipc-checklist'
import type { ChecklistApi, ChecklistUpdatePayload } from '../shared/ipc-checklist'

export function checklistBridge(
  request: <T>(channel: string, ...args: unknown[]) => Promise<Result<T>>,
  on: <T>(channel: string, handler: (payload: T) => void) => () => void
): ChecklistApi {
  return {
    get: (sessionId) => request(IPC_CHECKLIST_REQUESTS.CHECKLIST_GET, sessionId),
    mutate: (sessionId, checklistId, baseRev, requestId, op) =>
      request(IPC_CHECKLIST_REQUESTS.CHECKLIST_MUTATE, sessionId, checklistId, baseRev, requestId, op),
    onUpdate: (handler) => on<ChecklistUpdatePayload>(IPC_CHECKLIST_EVENTS.CHECKLIST_UPDATE, handler)
  }
}
