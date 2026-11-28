import { describe, expect, it, vi } from 'vitest'
import { FileDiffIcon, FileIcon } from 'lucide-react'
import type { DocumentTab } from '@/state/document-tabs-store'
import { ALL_PANELS, HOSTED_PANELS, documentTabIcon, getPanelDescriptor, isPinnedPanelId, tabItemIcon, tabItemName, usePanelCount } from './panel-registry'
import panelContract from '../../../../specs/124-tool-channel-1193/contracts/panel-actions.json'
import { buildTabItems } from './tab-items'

// The registry pulls the whole store barrel, which needs a browser `window`; the name and icon lookups need none of it.
// The agents store is a plain selector over a settable snapshot so `usePanelCount` can run outside React.
const agentGroups = vi.hoisted(() => ({ value: [] as Array<{ subagents: Array<{ status: string }> }> }))
vi.mock('@/state', () => ({
  useGitChangesStore: () => undefined,
  useAgentsStore: (select: (s: { groups: unknown }) => unknown) => select({ groups: agentGroups.value }),
  totalRunningAgents: (groups: typeof agentGroups.value) => groups.flatMap((g) => g.subagents).filter((a) => a.status === 'running').length
}))

const file: DocumentTab = { kind: 'file', path: 'src/a.ts', id: 'file:src/a.ts', dead: false }
const diff: DocumentTab = { kind: 'diff', group: 'staged', path: 'src/a.ts', id: 'diff:staged:src/a.ts', dead: false }
const [panel, fileItem, diffItem] = buildTabItems(['outline'], [file, diff])

describe('tabItemName', () => {
  it('names a panel from its descriptor', () => {
    expect(tabItemName(panel!, {})).toBe('Outline')
  })

  it('names a document from its label, falling back to its path', () => {
    expect(tabItemName(fileItem!, { [file.id]: 'a.ts' })).toBe('a.ts')
    expect(tabItemName(diffItem!, {})).toBe('src/a.ts')
  })
})

describe('tabItemIcon', () => {
  it('picks the panel icon, the file icon or the diff icon by kind', () => {
    expect(tabItemIcon(panel!)).toBe(getPanelDescriptor('outline')?.icon)
    expect(tabItemIcon(fileItem!)).toBe(FileIcon)
    expect(tabItemIcon(diffItem!)).toBe(FileDiffIcon)
    expect(documentTabIcon('diff')).toBe(FileDiffIcon)
  })
})

describe('checklist panel registration', () => {
  it('checklist_is_hosted_not_pinned', () => {
    expect(HOSTED_PANELS.some((p) => p.id === 'checklist')).toBe(true)
    expect(isPinnedPanelId('checklist')).toBe(false)
    expect(getPanelDescriptor('checklist')).toMatchObject({ name: 'Checklist', hasCount: false, actions: [] })
  })

  it('every_registered_panel_is_declared_in_the_agent_contract', () => {
    const declared = panelContract.panels.map((p) => p.id).sort()
    expect(ALL_PANELS.map((p) => p.id).sort()).toEqual(declared)
  })
})

describe('agents panel registration', () => {
  it('is_always_listed_in_the_rail_whatever_the_session', () => {
    expect(HOSTED_PANELS.some((p) => p.id === 'subagents')).toBe(true)
    expect(isPinnedPanelId('subagents')).toBe(false)
  })

  it('keeps_its_rail_position_between_file_explorer_and_side_chat', () => {
    const ids = HOSTED_PANELS.map((p) => p.id)
    expect(ids.slice(ids.indexOf('file-explorer'), ids.indexOf('side-chat') + 1)).toEqual(['file-explorer', 'subagents', 'side-chat'])
  })

  it('counts_running_agents_across_all_sessions_with_or_without_a_session', () => {
    agentGroups.value = [{ subagents: [{ status: 'running' }] }, { subagents: [{ status: 'running' }, { status: 'failed' }] }]
    expect(usePanelCount('subagents', null)).toEqual({ kind: 'running', value: 2 })
    expect(usePanelCount('subagents', 's1')).toEqual({ kind: 'running', value: 2 })
  })

  it('shows_no_count_when_nothing_is_running', () => {
    agentGroups.value = [{ subagents: [{ status: 'failed' }] }]
    expect(usePanelCount('subagents', 's1')).toBeNull()
  })
})
