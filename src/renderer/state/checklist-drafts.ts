import { create } from 'zustand'
import type { ChecklistItemDelivery } from '../../shared/ipc-checklist'
import type { ItemFormMode, NoteStamp } from '../features/right-pane/checklist/item-controls'

/** What the developer has typed for one item, kept until a send succeeds. */
export interface ItemDraft {
  mode: ItemFormMode
  text: string
}

/** What the last send left behind: where it went, or why it did not go. */
export type ItemNote = { kind: 'delivery'; delivery: ChecklistItemDelivery | 'saved' } | { kind: 'refusal'; message: string }

/** A note and the item revision and status it was recorded against; the controls drop it once either moves. */
export type StampedNote = ItemNote & { stamp: NoteStamp }

export interface ItemDraftKey {
  sessionId: string
  checklistId: string
  itemId: string
}

/** Item ids restart per checklist, so the checklist id is part of the key. */
export const draftKey = ({ sessionId, checklistId, itemId }: ItemDraftKey): string => JSON.stringify([sessionId, checklistId, itemId])

interface DraftsState {
  /** The one item whose form is open; opening another closes it. */
  openKey: string | null
  drafts: Record<string, ItemDraft>
  inFlight: Record<string, true>
  notes: Record<string, StampedNote>
  open: (key: string, mode?: ItemFormMode) => void
  /** Closes the form and keeps its draft. */
  close: () => void
  setMode: (key: string, mode: ItemFormMode) => void
  setText: (key: string, text: string) => void
  beginSend: (key: string) => void
  /** The send did not go: the draft stays and the reason is shown. */
  refuse: (key: string, message: string, stamp: NoteStamp) => void
  /** The send went: the draft goes with it. */
  succeed: (key: string, note: ItemNote | null, stamp: NoteStamp) => void
  /** A send that is not the form's own, like "Do this item", went: whatever is typed stays. */
  settle: (key: string, note: ItemNote | null, stamp: NoteStamp) => void
  /** Drops what belongs to Sessions that are gone. */
  pruneSessions: (keepIds: ReadonlySet<string>) => void
  /** Drops what belongs to the Session's earlier checklists once a new one is accepted. */
  pruneChecklists: (sessionId: string, keepChecklistId: string) => void
}

const without = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in record)) return record
  const { [key]: _gone, ...rest } = record
  return rest
}

const keepWhere = <T>(record: Record<string, T>, drop: (key: string) => boolean): Record<string, T> => {
  const kept = Object.entries(record).filter(([key]) => !drop(key))
  return kept.length === Object.keys(record).length ? record : Object.fromEntries(kept)
}

const evict = (state: DraftsState, drop: (key: string) => boolean): Partial<DraftsState> => {
  const drafts = keepWhere(state.drafts, drop)
  const inFlight = keepWhere(state.inFlight, drop)
  const notes = keepWhere(state.notes, drop)
  const openKey = state.openKey !== null && drop(state.openKey) ? null : state.openKey
  if (drafts === state.drafts && inFlight === state.inFlight && notes === state.notes && openKey === state.openKey) return state
  return { drafts, inFlight, notes, openKey }
}

const keyParts = (key: string): ItemDraftKey => {
  const [sessionId, checklistId, itemId] = JSON.parse(key) as [string, string, string]
  return { sessionId, checklistId, itemId }
}

export const useChecklistDraftsStore = create<DraftsState>((set) => ({
  openKey: null,
  drafts: {},
  inFlight: {},
  notes: {},
  open: (key, mode) =>
    set((state) => {
      const held = state.drafts[key]
      const next: ItemDraft = { mode: mode ?? held?.mode ?? 'ask', text: held?.text ?? '' }
      // A delivery line is news only for the form that just sent; a refusal belongs to the kept draft.
      const notes = state.notes[key]?.kind === 'delivery' ? without(state.notes, key) : state.notes
      return { openKey: key, drafts: held !== undefined && held.mode === next.mode ? state.drafts : { ...state.drafts, [key]: next }, notes }
    }),
  close: () => set((state) => (state.openKey === null ? state : { openKey: null })),
  setMode: (key, mode) => set((state) => ({ drafts: { ...state.drafts, [key]: { text: state.drafts[key]?.text ?? '', mode } } })),
  setText: (key, text) => set((state) => ({ drafts: { ...state.drafts, [key]: { mode: state.drafts[key]?.mode ?? 'ask', text } } })),
  beginSend: (key) => set((state) => ({ inFlight: { ...state.inFlight, [key]: true }, notes: without(state.notes, key) })),
  refuse: (key, message, stamp) =>
    set((state) => ({ inFlight: without(state.inFlight, key), notes: { ...state.notes, [key]: { kind: 'refusal', message, stamp } } })),
  succeed: (key, note, stamp) =>
    set((state) => ({
      inFlight: without(state.inFlight, key),
      drafts: without(state.drafts, key),
      openKey: state.openKey === key ? null : state.openKey,
      notes: note === null ? without(state.notes, key) : { ...state.notes, [key]: { ...note, stamp } }
    })),
  settle: (key, note, stamp) =>
    set((state) => ({ inFlight: without(state.inFlight, key), notes: note === null ? without(state.notes, key) : { ...state.notes, [key]: { ...note, stamp } } })),
  pruneSessions: (keepIds) => set((state) => evict(state, (key) => !keepIds.has(keyParts(key).sessionId))),
  pruneChecklists: (sessionId, keepChecklistId) =>
    set((state) =>
      evict(state, (key) => {
        const parts = keyParts(key)
        return parts.sessionId === sessionId && parts.checklistId !== keepChecklistId
      })
    )
}))

/** One item's slice, with the same object back while only another item changes. */
export const selectItemDraft = (state: Pick<DraftsState, 'drafts'>, key: string): ItemDraft | undefined => state.drafts[key]
