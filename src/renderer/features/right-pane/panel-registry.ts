import { BotIcon, HammerIcon, LibraryIcon, type LucideIcon } from 'lucide-react'
import { EMPTY_READOUT_ENTRY, useReadoutStore } from '@/state'

// Spec 013 (data-model.md `HostedPanelDescriptor`/`PanelId`): the single source of which right
// pane panels exist, read by the rail, the tab bar, and the launcher so none of the three keeps
// its own list. `HOSTED_PANELS` only lists a panel this build can actually render -- all three
// land here once PR2 (spec 013 Slice 3, tasks T026-T028) registers `fdb-knowledge`/
// `agent-builder` alongside PR1's `subagents`, so the rail and launcher never show an entry with
// no content behind it.
export type PanelId = 'subagents' | 'fdb-knowledge' | 'agent-builder'

export interface HostedPanelDescriptor {
  id: PanelId
  name: string
  icon: LucideIcon
  hasCount: boolean
}

export const HOSTED_PANELS: HostedPanelDescriptor[] = [
  { id: 'subagents', name: 'Subagents', icon: BotIcon, hasCount: true },
  { id: 'fdb-knowledge', name: 'FDB Knowledge', icon: LibraryIcon, hasCount: false },
  { id: 'agent-builder', name: 'Agent Builder', icon: HammerIcon, hasCount: false }
]

export function getPanelDescriptor(id: PanelId): HostedPanelDescriptor | undefined {
  return HOSTED_PANELS.find((panel) => panel.id === id)
}

// data-model.md `PanelCount`: per-render, computed -- never stored on the descriptor itself.
export type PanelCount =
  | { kind: 'running'; value: number }
  | { kind: 'additions-deletions'; additions: number; deletions: number }
  | null

export function formatPanelCount(count: PanelCount): string {
  if (!count) return ''
  if (count.kind === 'running') return `${count.value} running`
  return `+${count.additions} -${count.deletions}`
}

/** data-model.md `getPanelCount`, as a reactive hook: 'subagents' reads the number running for
 * whichever Session backs a per-Session panel's count -- `frontSessionId` (research.md:
 * "whichever Session's data should back a per-Session panel's count"), not necessarily the
 * Session this panel's own content is bound to. 'fdb-knowledge'/'agent-builder' always return
 * `null` in this spec (neither placeholder defines a count). */
export function usePanelCount(id: PanelId, sessionId: string | null): PanelCount {
  const running = useReadoutStore((s) =>
    id === 'subagents' && sessionId ? (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.subagentCount?.running : undefined
  )
  if (id !== 'subagents' || !sessionId) return null
  return running !== undefined && running > 0 ? { kind: 'running', value: running } : null
}
