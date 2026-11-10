import { BotIcon, CircleDotIcon, FolderTreeIcon, GaugeIcon, GitBranchIcon, GitPullRequestIcon, HammerIcon, LibraryIcon, ListTreeIcon, MessageCircleIcon, type LucideIcon } from 'lucide-react'
import { EMPTY_READOUT_ENTRY, useGitChangesStore, useReadoutStore } from '@/state'
import panelContract from '../../../../specs/124-tool-channel-1193/contracts/panel-actions.json'

export type PanelId =
  | 'subagents' | 'fdb-knowledge' | 'agent-builder' | 'side-chat' | 'file-explorer' | 'git-changes' | 'outline' | 'session-usage'
  | PinnedPanelId

export type PinnedPanelId = 'pull-request' | 'issue'

export function isPinnedPanelId(id: string): id is PinnedPanelId {
  return id === 'pull-request' || id === 'issue'
}

/** JSON Schema fragment; Rust checks the same declaration, so it stays plain data. */
export type PanelJsonSchema = Record<string, unknown>

export interface PanelActionDescriptor {
  name: string
  description: string
  inputSchema: PanelJsonSchema
  mutates: boolean
}

export interface HostedPanelDescriptor {
  id: PanelId
  name: string
  icon: LucideIcon
  hasCount: boolean
  /** What an agent may drive here, read from the shared contract so `mutates` cannot drift from Rust's approval gate. */
  actions: PanelActionDescriptor[]
  openInputSchema?: PanelJsonSchema
}

interface ContractPanel {
  id: string
  actions: PanelActionDescriptor[]
  openInputSchema?: PanelJsonSchema
}

const CONTRACT_PANELS = new Map<string, ContractPanel>((panelContract.panels as ContractPanel[]).map((panel) => [panel.id, panel]))

function declared(id: PanelId): Pick<HostedPanelDescriptor, 'actions' | 'openInputSchema'> {
  const panel = CONTRACT_PANELS.get(id)
  return { actions: panel?.actions ?? [], ...(panel?.openInputSchema ? { openInputSchema: panel.openInputSchema } : {}) }
}

export const HOSTED_PANELS: HostedPanelDescriptor[] = [
  { id: 'git-changes', name: 'Git changes', icon: GitBranchIcon, hasCount: true, ...declared('git-changes') },
  { id: 'file-explorer', name: 'File explorer', icon: FolderTreeIcon, hasCount: false, ...declared('file-explorer') },
  { id: 'subagents', name: 'Subagents', icon: BotIcon, hasCount: true, ...declared('subagents') },
  { id: 'side-chat', name: 'Side chat', icon: MessageCircleIcon, hasCount: false, ...declared('side-chat') },
  { id: 'fdb-knowledge', name: 'FDB Knowledge', icon: LibraryIcon, hasCount: false, ...declared('fdb-knowledge') },
  { id: 'agent-builder', name: 'Agent Builder', icon: HammerIcon, hasCount: false, ...declared('agent-builder') },
  { id: 'outline', name: 'Outline', icon: ListTreeIcon, hasCount: false, ...declared('outline') },
  { id: 'session-usage', name: 'Session usage', icon: GaugeIcon, hasCount: false, ...declared('session-usage') }
]

// Opened only from the chat header, so they stay out of the rail, launcher and saved layout.
const PINNED_PANELS: HostedPanelDescriptor[] = [
  { id: 'pull-request', name: 'Pull request', icon: GitPullRequestIcon, hasCount: false, ...declared('pull-request') },
  { id: 'issue', name: 'Issue', icon: CircleDotIcon, hasCount: false, ...declared('issue') }
]

/** Every panel an agent can see, rail panels first. */
export const ALL_PANELS: readonly HostedPanelDescriptor[] = [...HOSTED_PANELS, ...PINNED_PANELS]

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
