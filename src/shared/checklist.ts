// Hand-written mirror of `src-tauri/src/checklist/model.rs`. Rust is the source of
// truth; `checklist.test.ts` reads the golden fixture and the Rust constants block so a key or cap
// that drifts on either side fails a test. Standalone, like `todo.ts`: the OMP todo is a different thing.

/** The five item statuses, in display order. */
export const ITEM_STATUSES = ['upcoming', 'next', 'in_progress', 'blocked', 'complete'] as const;
/** One of the item statuses. */
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Who an item belongs to. The agent picks it per item at create and add; it is fixed after. */
export const ITEM_OWNERS = ['agent', 'human', 'either'] as const;
/** One of the item owners. */
export type ItemOwner = (typeof ITEM_OWNERS)[number];

/** Who made a change: the agent or the developer. */
export type Actor = 'agent' | 'developer';
/** Kind of operation applied to an item. */
export type OpKind = 'add' | 'edit' | 'move' | 'remove' | 'setStatus' | 'setValue';
/** What a developer send did with an item. */
export type SendAction = 'complete' | 'ask' | 'value';

/** A recent developer operation on an item, used to tell the agent what changed. */
export interface LastDeveloperOp {
  kind: OpKind;
  rev: number;
  fields: string[];
}

/** One checklist entry with its status, owner, value and change stamps. */
export interface ChecklistItem {
  id: string;
  text: string;
  status: ItemStatus;
  previousStatus?: ItemStatus;
  owner: ItemOwner;
  requiresValue: boolean;
  value?: string;
  valueBy?: Actor;
  agentCompletable: boolean;
  group?: string;
  rev: number;
  statusRev: number;
  createdBy: Actor;
  updatedBy: Actor;
  completedBy?: Actor;
  editedByDeveloper: boolean;
  lastDeveloperOps: LastDeveloperOp[];
}

/** A removed item's id, kept so the agent can be told it is gone. */
export interface RemovedEntry {
  id: string;
  rev: number;
  by: Actor;
}

/** A remembered request id with the revision and ids it produced. */
export interface RecentRequest {
  requestId: string;
  rev: number;
  addedIds: string[];
}

/** One checklist with its items and the bookkeeping that separates agent and developer edits. */
export interface Checklist {
  id: string;
  title: string;
  rev: number;
  nextItemSeq: number;
  agentSeenRev: number;
  issuedSeenRev: number;
  createdAt: string;
  items: ChecklistItem[];
  removed: RemovedEntry[];
  recentRequests: RecentRequest[];
}

/** A developer send already issued for an item, so a repeat is not sent twice. */
export interface SendRecord {
  checklistId: string;
  itemId: string;
  rev: number;
  action: SendAction;
  textHash: string;
}

/** A send that completes an item once the agent's turn finishes. */
export interface PendingComplete {
  checklistId: string;
  itemId: string;
  turnMarker: number;
  started: boolean;
}

/** The per-Session checklist file: active checklist, archive and counters. */
export interface ChecklistFile {
  version: number;
  nextChecklistSeq: number;
  active: Checklist | null;
  archived: Checklist[];
  sendRecords: SendRecord[];
  pendingComplete: PendingComplete[];
}

/** Rust `MAX_*` constants in `checklist/model.rs`, camelCased (`MAX_TEXT_BYTES` -> `maxTextBytes`). */
export const CHECKLIST_CAPS = {
  fileVersion: 1,
  maxTextBytes: 200,
  maxTitleBytes: 120,
  maxGroupBytes: 60,
  maxValueBytes: 1024,
  maxItemMessageBytes: 4096,
  maxRequestIdBytes: 64,
  maxItems: 40,
  maxArchived: 5,
  maxOps: 20,
  maxSendRecords: 500,
  maxRemoved: 40,
  maxRecentRequests: 16,
  maxUserChanges: 20,
} as const;

// `Record<keyof T, true>` makes each list exhaustive: adding a field to an interface fails to compile
// until it is listed here, and the test compares the lists with the fixture's keys.
const key = <T>(keys: Record<keyof T, true>): string[] => Object.keys(keys);

/** Property names of the file object, checked against the fixture. */
export const FILE_KEYS = key<ChecklistFile>({
  version: true,
  nextChecklistSeq: true,
  active: true,
  archived: true,
  sendRecords: true,
  pendingComplete: true,
});
/** Property names of a checklist, checked against the fixture. */
export const CHECKLIST_KEYS = key<Checklist>({
  id: true,
  title: true,
  rev: true,
  nextItemSeq: true,
  agentSeenRev: true,
  issuedSeenRev: true,
  createdAt: true,
  items: true,
  removed: true,
  recentRequests: true,
});
/** Property names of an item, checked against the fixture. */
export const ITEM_KEYS = key<ChecklistItem>({
  id: true,
  text: true,
  status: true,
  previousStatus: true,
  owner: true,
  requiresValue: true,
  value: true,
  valueBy: true,
  agentCompletable: true,
  group: true,
  rev: true,
  statusRev: true,
  createdBy: true,
  updatedBy: true,
  completedBy: true,
  editedByDeveloper: true,
  lastDeveloperOps: true,
});
/** Property names of a last-developer-op entry. */
export const LAST_DEVELOPER_OP_KEYS = key<LastDeveloperOp>({ kind: true, rev: true, fields: true });
/** Property names of a removed entry. */
export const REMOVED_KEYS = key<RemovedEntry>({ id: true, rev: true, by: true });
/** Property names of a recent request. */
export const RECENT_REQUEST_KEYS = key<RecentRequest>({ requestId: true, rev: true, addedIds: true });
/** Property names of a send record. */
export const SEND_RECORD_KEYS = key<SendRecord>({
  checklistId: true,
  itemId: true,
  rev: true,
  action: true,
  textHash: true,
});
/** Property names of a pending-complete entry. */
export const PENDING_COMPLETE_KEYS = key<PendingComplete>({
  checklistId: true,
  itemId: true,
  turnMarker: true,
  started: true,
});
