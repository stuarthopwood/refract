// Checklist panel channels (#2011). `ipc.ts` is at its line cap.

import type { Result } from './ipc'
import type { Actor, Checklist, ItemOwner, ItemStatus } from './checklist'

export const IPC_CHECKLIST_REQUESTS = {
  CHECKLIST_GET: 'checklist.get',
  CHECKLIST_MUTATE: 'checklist.mutate',
  CHECKLIST_ITEM_MESSAGE: 'checklist.itemMessage'
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

/** What the developer sends about one item: a question, a value for the agent, or "do this step". */
export type ChecklistItemAction = 'ask' | 'value' | 'complete'

/** Where the turn went: now, behind a running turn, or held while the Session is paused. */
export type ChecklistItemDelivery = 'sent' | 'queued' | 'held'

/** The turn was sent, plus the checklist as it now stands. */
export interface ChecklistItemSent {
  delivery: ChecklistItemDelivery
  checklist: Checklist
}

/** A refused change: the reason plus the checklist as it now stands, so the panel can resync. */
export interface ChecklistRefusal {
  error: { code: string; message: string }
  checklist: Checklist | null
}

/** The applied checklist, or a refusal. */
export type ChecklistMutateResult = Checklist | ChecklistRefusal

/** The sent result, or a refusal that carries the checklist to resync from. */
export type ChecklistItemMessageResult = ChecklistItemSent | ChecklistRefusal

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

/** `checklist.get`: the Session's active checklist (null when it has none) and the tool-refused flag. */
export interface ChecklistGetResult {
  checklist: Checklist | null
  /** True when the agent was refused the checklist tool, so no checklist can be created. */
  toolUnavailable: boolean
}

export interface ChecklistApi {
  get(sessionId: string): Promise<Result<ChecklistGetResult>>
  /** A repeated `requestId` returns the current checklist without applying again. */
  mutate(
    sessionId: string,
    checklistId: string,
    baseRev: number,
    requestId: string | null,
    op: ChecklistOp
  ): Promise<Result<ChecklistMutateResult>>
  /** Sends one item action to the Session's agent; a send the Session refuses is an error Result. */
  itemMessage(
    sessionId: string,
    checklistId: string,
    itemId: string,
    baseRev: number,
    action: ChecklistItemAction,
    text?: string
  ): Promise<Result<ChecklistItemMessageResult>>
  onUpdate(handler: (payload: ChecklistUpdatePayload) => void): () => void
}

declare module './ipc' {
  interface RefractApi {
    checklist: ChecklistApi
  }
}
