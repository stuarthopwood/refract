import { create } from 'zustand'
import type { ChecklistItemDelivery } from '../../shared/ipc-checklist'
import type { ItemFormMode } from '../features/right-pane/checklist/item-controls'

/** What the developer has typed for one item, kept until a send succeeds. */
export interface ItemDraft {
  mode: ItemFormMode
  text: string
}

/** What the last send left behind: where it went, or why it did not go. */
export type ItemNote = { kind: 'delivery'; delivery: ChecklistItemDelivery | 'saved' } | { kind: 'refusal'; message: string }

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
  notes: Record<string, ItemNote>
  open: (key: string, mode?: ItemFormMode) => void
  /** Closes the form and keeps its draft. */
  close: () => void
  setMode: (key: string, mode: ItemFormMode) => void
  setText: (key: string, text: string) => void
  beginSend: (key: string) => void
  /** The send did not go: the draft stays and the reason is shown. */
  refuse: (key: string, message: string) => void
  /** The send went: the draft goes with it. */
  succeed: (key: string, note: ItemNote | null) => void
  clearNote: (key: string) => void
}

const without = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in record)) return record
  const { [key]: _gone, ...rest } = record
  return rest
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
  refuse: (key, message) => set((state) => ({ inFlight: without(state.inFlight, key), notes: { ...state.notes, [key]: { kind: 'refusal', message } } })),
  succeed: (key, note) =>
    set((state) => ({
      inFlight: without(state.inFlight, key),
      drafts: without(state.drafts, key),
      openKey: state.openKey === key ? null : state.openKey,
      notes: note === null ? without(state.notes, key) : { ...state.notes, [key]: note }
    })),
  clearNote: (key) => set((state) => (key in state.notes ? { notes: without(state.notes, key) } : state))
}))

/** One item's slice, with the same object back while only another item changes. */
export const selectItemDraft = (state: Pick<DraftsState, 'drafts'>, key: string): ItemDraft | undefined => state.drafts[key]
