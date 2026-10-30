import { SETTINGS_SECTIONS } from '@/features/settings/SettingsNav'
import { openSession } from '@/features/home/HomeSessionSections'
import { useIssuesStore, usePullRequestsStore, useRepositoriesStore, useSessionsStore, useViewStore } from '@/state'
import type { ConversationInfo } from '../../../shared/model'
import { chordText, getActions, isActionEnabled } from './actionRegistry'
import { openConversation } from './openConversation'

/** Palette sections in the order an empty query lists them. */
export const PALETTE_SECTIONS = ['Actions', 'Sessions', 'Conversations', 'Settings', 'Pull requests and Issues'] as const
export type PaletteSection = (typeof PALETTE_SECTIONS)[number]

/** One selectable row in the palette. */
export interface PaletteItem {
  id: string
  section: PaletteSection
  label: string
  hint?: string
  chord?: string
  run(): void
}

/** Most rows rendered per section, so a long Session or issue list cannot stall the listbox. */
export const MAX_ROWS_PER_SECTION = 50

/** The Conversations of one Session, as loaded for the palette. */
export interface PaletteConversations {
  sessionId: string
  conversations: ConversationInfo[]
}

/** Every row the palette can show right now, before the query filters it. */
export function buildPaletteItems(loaded: PaletteConversations | null): PaletteItem[] {
  const items: PaletteItem[] = []
  for (const action of getActions()) {
    if (action.id === 'open-palette' || !isActionEnabled(action)) continue
    items.push({ id: `action:${action.id}`, section: 'Actions', label: action.label, chord: action.chord ? chordText(action.chord) : undefined, run: action.run })
  }

  const repositoryNames = new Map(useRepositoriesStore.getState().repositories.map((repository) => [repository.id, repository.name]))
  const sessions = useSessionsStore.getState().sessions
  for (const session of sessions) {
    if (session.archivedAt || session.hiddenAt) continue
    items.push({ id: `session:${session.id}`, section: 'Sessions', label: session.name, hint: repositoryNames.get(session.repositoryId), run: () => openSession(session) })
  }

  if (loaded) {
    const status = sessions.find((session) => session.id === loaded.sessionId)?.status
    for (const conversation of loaded.conversations) {
      items.push({
        id: `conversation:${conversation.id}`,
        section: 'Conversations',
        label: conversation.title || conversation.preview || 'Untitled conversation',
        hint: conversation.isCurrent ? 'Current' : undefined,
        run: () => {
          if (conversation.isCurrent) return
          void openConversation(loaded.sessionId, conversation.file, status)
        }
      })
    }
  }

  for (const section of SETTINGS_SECTIONS) {
    items.push({ id: `settings:${section.id}`, section: 'Settings', label: `Settings: ${section.label}`, run: () => useViewStore.getState().openSettings(section.id) })
  }

  for (const pullRequest of usePullRequestsStore.getState().items) {
    items.push({
      id: `pr:${pullRequest.repositoryId}:${pullRequest.number}`,
      section: 'Pull requests and Issues',
      label: `#${pullRequest.number} ${pullRequest.title}`,
      hint: `Pull request, ${pullRequest.repositoryName}`,
      run: () => {
        usePullRequestsStore.getState().select({ repositoryId: pullRequest.repositoryId, number: pullRequest.number })
        useViewStore.getState().openPullRequests()
      }
    })
  }
  for (const issue of useIssuesStore.getState().items) {
    items.push({
      id: `issue:${issue.repositoryId}:${issue.number}`,
      section: 'Pull requests and Issues',
      label: `#${issue.number} ${issue.title}`,
      hint: `Issue, ${issue.repositoryName}`,
      run: () => {
        useIssuesStore.getState().select({ repositoryId: issue.repositoryId, number: issue.number })
        useViewStore.getState().openIssues()
      }
    })
  }
  return items
}

// 3 prefix, 2 substring, 1 in-order subsequence, 0 no match.
function fuzzyScore(text: string, query: string): number {
  const haystack = text.toLowerCase()
  if (haystack.startsWith(query)) return 3
  if (haystack.includes(query)) return 2
  let at = 0
  for (const char of query) {
    at = haystack.indexOf(char, at) + 1
    if (at === 0) return 0
  }
  return 1
}

/** Filters and ranks items for a raw query; a leading `>` limits the list to Actions. */
export function rankPaletteItems(items: readonly PaletteItem[], rawQuery: string): PaletteItem[] {
  const actionsOnly = rawQuery.startsWith('>')
  const query = (actionsOnly ? rawQuery.slice(1) : rawQuery).trim().toLowerCase()
  const scored: { item: PaletteItem; score: number; order: number }[] = []
  items.forEach((item, order) => {
    if (actionsOnly && item.section !== 'Actions') return
    const score = query === '' ? 1 : Math.max(fuzzyScore(item.label, query), item.hint ? fuzzyScore(item.hint, query) * 0.5 : 0)
    if (score > 0) scored.push({ item, score, order })
  })
  scored.sort((a, b) => b.score - a.score || a.order - b.order)
  const taken = new Map<PaletteSection, number>()
  const result: PaletteItem[] = []
  for (const { item } of scored) {
    const count = taken.get(item.section) ?? 0
    if (count >= MAX_ROWS_PER_SECTION) continue
    taken.set(item.section, count + 1)
    result.push(item)
  }
  return result
}
