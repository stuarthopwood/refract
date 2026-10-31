import { BotIcon, CircleDotIcon, FolderTreeIcon, GaugeIcon, GitBranchIcon, GitPullRequestIcon, HammerIcon, LibraryIcon, ListTreeIcon, MessageCircleIcon, type LucideIcon } from 'lucide-react'
import { EMPTY_READOUT_ENTRY, useGitChangesStore, useReadoutStore } from '@/state'

export type PanelId =
  | 'subagents' | 'fdb-knowledge' | 'agent-builder' | 'side-chat' | 'file-explorer' | 'git-changes' | 'outline' | 'session-usage'
  | 'pull-request' | 'issue'

export type PinnedPanelId = 'pull-request' | 'issue'

export function isPinnedPanelId(id: string): id is PinnedPanelId {
  return id === 'pull-request' || id === 'issue'
}

export interface HostedPanelDescriptor {
  id: PanelId
  name: string
  icon: LucideIcon
  hasCount: boolean
}

export const HOSTED_PANELS: HostedPanelDescriptor[] = [
  { id: 'git-changes', name: 'Git changes', icon: GitBranchIcon, hasCount: true },
  { id: 'file-explorer', name: 'File explorer', icon: FolderTreeIcon, hasCount: false },
  { id: 'subagents', name: 'Subagents', icon: BotIcon, hasCount: true },
  { id: 'side-chat', name: 'Side chat', icon: MessageCircleIcon, hasCount: false },
  { id: 'fdb-knowledge', name: 'FDB Knowledge', icon: LibraryIcon, hasCount: false },
  { id: 'agent-builder', name: 'Agent Builder', icon: HammerIcon, hasCount: false },
  { id: 'outline', name: 'Outline', icon: ListTreeIcon, hasCount: false },
  { id: 'session-usage', name: 'Session usage', icon: GaugeIcon, hasCount: false }
]

// Opened only from the chat header, so they stay out of the rail, launcher and saved layout.
const PINNED_PANELS: HostedPanelDescriptor[] = [
  { id: 'pull-request', name: 'Pull request', icon: GitPullRequestIcon, hasCount: false },
  { id: 'issue', name: 'Issue', icon: CircleDotIcon, hasCount: false }
]

export function getPanelDescriptor(id: PanelId): HostedPanelDescriptor | undefined {
  return HOSTED_PANELS.find((panel) => panel.id === id) ?? PINNED_PANELS.find((panel) => panel.id === id)
}

// data-model.md `PanelCount`: per-render, computed -- never stored on the descriptor itself.
export type PanelCount =
  | { kind: 'running'; value: number }
  | { kind: 'additions-deletions'; files: number; additions: number; deletions: number }
  | null

/** Spec 024 FR-010: the figure a rail badge shows and the phrase its accessible name carries. */
export function railCountLabel(count: PanelCount): { value: number; phrase: string } | null {
  if (!count) return null
  if (count.kind === 'running') return { value: count.value, phrase: `${count.value} running` }
  return { value: count.files, phrase: `${count.files} ${count.files === 1 ? 'file' : 'files'} changed` }
}

export interface PanelCountParts {
  /** Always shown in full -- FR-012's "never the only signal" figure. */
  number: string
  /** '' when the shape has no separate trailing word (`+a -d`, both numbers already). */
  word: string
}

export function splitPanelCount(count: PanelCount): PanelCountParts | null {
  if (!count) return null
  if (count.kind === 'running') return { number: String(count.value), word: 'running' }
  return { number: `+${count.additions} -${count.deletions}`, word: '' }
}

/** The one figure a tab shows once the strip is too tight for the full count (#1270). */
export function compactPanelCount(count: PanelCount): string | null {
  const label = railCountLabel(count)
  return label ? String(label.value) : null
}

export function formatPanelCount(count: PanelCount): string {
  const parts = splitPanelCount(count)
  if (!parts) return ''
  return parts.word ? `${parts.number} ${parts.word}` : parts.number
}

/** `getPanelCount` as a reactive hook. */
export function usePanelCount(id: PanelId, sessionId: string | null): PanelCount {
  const running = useReadoutStore((s) =>
    id === 'subagents' && sessionId ? (s.bySession[sessionId] ?? EMPTY_READOUT_ENTRY).readout.subagentCount?.running : undefined
  )
  const gitChangesSnapshot = useGitChangesStore((s) =>
    id === 'git-changes' && sessionId ? (s.bySession[sessionId]?.snapshot ?? null) : null
  )
  if (id === 'subagents') {
    if (!sessionId) return null
    return running !== undefined && running > 0 ? { kind: 'running', value: running } : null
  }
  if (id === 'git-changes') {
    if (!gitChangesSnapshot) return null
    let files = 0
    let additions = 0
    let deletions = 0
    for (const entries of Object.values(gitChangesSnapshot.groups)) {
      for (const entry of entries) {
        files += 1
        additions += entry.additions
        deletions += entry.deletions
      }
    }
    return files > 0 ? { kind: 'additions-deletions', files, additions, deletions } : null
  }
  return null
}
