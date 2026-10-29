import { BotIcon, FolderTreeIcon, GitBranchIcon, HammerIcon, LibraryIcon, ListTreeIcon, MessageCircleIcon, type LucideIcon } from 'lucide-react'
import { EMPTY_READOUT_ENTRY, useGitChangesStore, useReadoutStore } from '@/state'

// Spec 013 (data-model.md `HostedPanelDescriptor`/`PanelId`): the single source of which right
// pane panels exist, read by the rail, the tab bar, and the launcher so none of the three keeps
// its own list. `HOSTED_PANELS` only lists a panel this build can actually render -- all three
// land here once PR2 (spec 013 Slice 3, tasks T026-T028) registers `fdb-knowledge`/
// `agent-builder` alongside PR1's `subagents`, so the rail and launcher never show an entry with
// no content behind it. `side-chat` (spec 014 T005) and `file-explorer` (spec 015 T006) each add
// a tenant the same way, no change to the rail/tab-bar/launcher rendering logic itself
// (research.md decision 4, spec 014; decision 9, spec 015).
export type PanelId = 'subagents' | 'fdb-knowledge' | 'agent-builder' | 'side-chat' | 'file-explorer' | 'git-changes' | 'outline'

export interface HostedPanelDescriptor {
  id: PanelId
  name: string
  icon: LucideIcon
  hasCount: boolean
}

// Issue #730 (FR-112): the literal order below IS the default panel order (Git changes, File
// explorer, Subagents, Side chat, FDB Knowledge, Agent Builder); `panel-order.ts` applies the
// user's saved order on top for the rail and the launcher.
export const HOSTED_PANELS: HostedPanelDescriptor[] = [
  // Spec 018 slice 1 research.md decision 5: distinct from `FolderTreeIcon` below (that one
  // already means "browse this worktree's files"); the branch glyph reads as "this worktree's
  // Git state" specifically. `hasCount: true`: the `additions-deletions` shape below, already
  // defined for this purpose, previously unused.
  { id: 'git-changes', name: 'Git changes', icon: GitBranchIcon, hasCount: true },
  // Spec 015 research.md decision 8: distinct from every icon already in use on a right-pane
  // rail button or an existing file-system action (`FolderOpenIcon` already means "open the OS
  // file explorer" elsewhere in this codebase, e.g. `AddRepositoryDialog.tsx`'s Browse button
  // and this very panel's own Reveal in File Explorer action, Slice 3) -- the literal "a folder
  // containing a nested tree" shape avoids conflating "open this panel" with that action. No
  // live count is asked for by the issue.
  { id: 'file-explorer', name: 'File explorer', icon: FolderTreeIcon, hasCount: false },
  { id: 'subagents', name: 'Subagents', icon: BotIcon, hasCount: true },
  // Spec 014 research.md decision 5: a single-bubble icon, distinct from the others, chosen
  // over MessagesSquareIcon (closer to "messaging app" than "one aside conversation"). No live
  // count is asked for by either issue.
  { id: 'side-chat', name: 'Side chat', icon: MessageCircleIcon, hasCount: false },
  { id: 'fdb-knowledge', name: 'FDB Knowledge', icon: LibraryIcon, hasCount: false },
  { id: 'agent-builder', name: 'Agent Builder', icon: HammerIcon, hasCount: false },
  // Spec 041 (#752): last by default; a saved order keeps its own arrangement and
  // `mergePanelOrder` slots this one in after the nearest earlier default panel.
  { id: 'outline', name: 'Outline', icon: ListTreeIcon, hasCount: false }
]

export function getPanelDescriptor(id: PanelId): HostedPanelDescriptor | undefined {
  return HOSTED_PANELS.find((panel) => panel.id === id)
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

// Round 5 gate remediation (Low, Code4): one source for the count's text, split into its number
// and its trailing word (if any) -- `formatPanelCount` (the full string, for the launcher row and
// for tooltips/accessible names) and `PanelTabBar.tsx`'s own split rendering (the number never
// shrinks, FR-012; only the word may truncate) both build from this, instead of each re-deriving
// the `running`/`+a -d` shapes independently.
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

/** #1270: the ONE figure a tab shows once the strip is too tight for the full count (the rail
 * badge's own figure: running agents, or changed files for Git). */
export function compactPanelCount(count: PanelCount): string | null {
  const label = railCountLabel(count)
  return label ? String(label.value) : null
}

export function formatPanelCount(count: PanelCount): string {
  const parts = splitPanelCount(count)
  if (!parts) return ''
  return parts.word ? `${parts.number} ${parts.word}` : parts.number
}

/** data-model.md `getPanelCount`, as a reactive hook: 'subagents' reads the number running for
 * whichever Session backs a per-Session panel's count -- `frontSessionId` (research.md:
 * "whichever Session's data should back a per-Session panel's count"), not necessarily the
 * Session this panel's own content is bound to. 'fdb-knowledge'/'agent-builder' always return
 * `null` in this spec (neither placeholder defines a count). Spec 018 slice 1 (FR-020):
 * 'git-changes' sums every visible file row's additions/deletions across all four groups of the
 * currently-loaded snapshot for `sessionId` -- `null` until a snapshot has actually loaded,
 * never a stale zero. */
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
    // Spec 024 FR-008/FR-009: a clean tree shows no count (tested on files, so a binary-only
    // change with 0/0 line counts still counts).
    return files > 0 ? { kind: 'additions-deletions', files, additions, deletions } : null
  }
  return null
}
