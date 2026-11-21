import type { Checklist, ChecklistItem } from '../../../../shared/checklist'

/** A checklist item with defaults; tests override only what they care about. */
export function makeItem(overrides: Partial<ChecklistItem> & { id: string }): ChecklistItem {
  return {
    text: `Item ${overrides.id}`,
    status: 'upcoming',
    owner: 'either',
    requiresValue: false,
    agentCompletable: true,
    rev: 1,
    statusRev: 1,
    createdBy: 'agent',
    updatedBy: 'agent',
    editedByDeveloper: false,
    lastDeveloperOps: [],
    ...overrides
  }
}

/** A checklist with defaults; tests override only what they care about. */
export function makeChecklist(overrides: Partial<Checklist> = {}): Checklist {
  return {
    id: 'p1',
    title: 'Ship it',
    rev: 1,
    nextItemSeq: 2,
    agentSeenRev: 0,
    issuedSeenRev: 0,
    createdAt: '2026-11-20T10:00:00Z',
    items: [makeItem({ id: 'i1' })],
    removed: [],
    recentRequests: [],
    ...overrides
  }
}
