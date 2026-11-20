// Checklist panel channels (#2011). `ipc.ts` is at its line cap.

import type { Result } from './ipc'
import type { Actor, Checklist, ItemOwner, ItemStatus } from './checklist'

export const IPC_CHECKLIST_REQUESTS = {
  CHECKLIST_GET: 'checklist.get',
  CHECKLIST_MUTATE: 'checklist.mutate'
} as const

export const IPC_CHECKLIST_EVENTS = {
  CHECKLIST_UPDATE: 'checklist:update'
} as const

/** The item an `add` op creates; omitted fields take the engine's defaults. */
export interface ChecklistNewItem {
  text: string
  owner?: ItemOwner
  requiresValue?: boolean
  agentCompletable?: boolean
  group?: string
}

/** One developer edit; `after` null or absent places the item last. */
export type ChecklistOp =
  | { op: 'add'; after?: string | null; item: ChecklistNewItem }
  | {
      op: 'edit'
      id: string
      text?: string
      group?: string
      owner?: ItemOwner
      requiresValue?: boolean
      agentCompletable?: boolean
    }
  | { op: 'move'; id: string; after?: string | null }
  | { op: 'remove'; id: string }
  | { op: 'setStatus'; id: string; status: ItemStatus }
  | { op: 'setValue'; id: string; value: string }

/** A refused change: the reason plus the checklist as it now stands, so the panel can resync. */
export interface ChecklistRefusal {
  error: { code: string; message: string }
  checklist: Checklist | null
}

/** The applied checklist, or a refusal. */
export type ChecklistMutateResult = Checklist | ChecklistRefusal

/**
 * `checklist:update`: the whole checklist, never a delta; `opened` is set only when the agent created it.
 * Payloads can arrive out of order across writers: drop one whose `checklist.rev` is not above the rev
 * already held for that `checklistId`.
 */
export interface ChecklistUpdatePayload {
  sessionId: string
  checklist: Checklist
  by: Actor
  opened?: true
}

export interface ChecklistApi {
  /** The Session's active checklist, or null when it has none. */
  get(sessionId: string): Promise<Result<Checklist | null>>
  /** A repeated `requestId` returns the current checklist without applying again. */
  mutate(
    sessionId: string,
    checklistId: string,
    baseRev: number,
    requestId: string | null,
    op: ChecklistOp
  ): Promise<Result<ChecklistMutateResult>>
  onUpdate(handler: (payload: ChecklistUpdatePayload) => void): () => void
}

declare module './ipc' {
  interface RefractApi {
    checklist: ChecklistApi
  }
}
