
import type { ThemeId } from './themes'; import type { StatusStyle } from './statusStyle'; import type { ChatRowDensity } from './chatRowDensity'; import type { ActivityReadoutFields, ActivityText } from './activity'; import type { RightPaneSettings } from './rightPane';
import type { PullRequestState } from './github';
import type { ChatWidth } from './chatWidth'; import type { HolidayTouches } from './holidayTouches';
import type { TranscriptDisplaySettings } from './transcriptDisplay';
import type { TodoPhase } from './todo'; import type { TranscriptImageRef } from './ipc-images';

/** A local git project the developer has added to Refract. */
export interface Repository {
  id: string;
  path: string;
  // An empty (after trimming) rename resets it back to the folder's own basename.
  name: string;
  defaultBranch: string;
  addedAt: string;
  color?: ProjectColor;
  // NEVER persisted in `registry.json` -- the remote can change on disk with no Refract action.
  // Optional only because it is absent until that first computation.
  remote?: RepositoryRemote;
}

/** A preset id (see `projectColor.ts`) or a custom hex exactly as typed. */
export type ProjectColor = { kind: 'preset'; id: string } | { kind: 'custom'; hex: string };

/** `unknown` means detection could not confirm either way, never conflated with a confirmed `none`. */
export type RepositoryRemote =
  | { kind: 'none' }
  // `owner` and `repo` come from the remote URL path (credentials never included); absent when the
  // path does not hold two segments.
  | { kind: 'has'; host: string; owner?: string; repo?: string }
  | { kind: 'unknown' };

/** One unit of work: a Worktree together with the Conversations held in it. */
export interface Session {
  id: string;
  repositoryId: string;
  name: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  sessionDir: string | null;
  currentConversation: string | null;
  lastMessageCount: number | null;
  // Written by `SessionAgent.syncFromState` at session start and after every settle.
  lastModel?: { provider: string; id: string; name?: string };
  lastThinkingLevel?: string;
  createdAt: string;
  lastActivityAt: string;
  archivedAt: string | null; hiddenAt?: string | null;
  currentTurnSubagents?: string[];
  stoppedOnRequestConversation?: string | null;
  stoppedOnRequestAtSize?: number | null;
  /** The issue this Session was started from (#1310); absent for every other Session. */
  originIssue?: { number: number; title: string; url: string };
  /** The parent Session when this is a Child Session (#1859); absent for a root Session. */
  parentSessionId?: string;
}
/** The app-wide setting for how much the agent may do without asking. */
export type ApprovalMode = 'ask' | 'ask-and-remember' | 'edit-freely' | 'auto';

export type ReadoutKind =
  | 'changes'
  | 'context-usage'
  | 'turn-time'
  | 'current-time'
  | 'subagents'
  | 'todo-progress' | 'current-work';

/** One-shot composer-clock alarm (#1426); `fireAtMs` is a UTC epoch in ms and `active` turns false once it fires. */
export interface Alarm { id: string; label: string; fireAtMs: number; active: boolean }
/** Alarm list and label caps; the Rust store enforces the same values (`store/alarms.rs`). */
export const MAX_ALARMS = 20
export const MAX_ALARM_LABEL_CHARS = 80

export interface Settings {
  version: 1;
  approvalMode: ApprovalMode;
  sessionReadout: Record<ReadoutKind, boolean>;
  split: SplitLayout | null;
  theme: ThemeId;
  watermarkEnabled: boolean;
  chatWidth: ChatWidth; customTheme: string | null; holidayTouches: HolidayTouches; activityText?: ActivityText; statusStyle?: StatusStyle; chatRowDensity?: ChatRowDensity;
  transcriptDisplay: TranscriptDisplaySettings;
  showSampleData: boolean;
  detectImagePathsOnPaste: boolean; showContextUsageBar?: boolean;
  wordPredictionEnabled: boolean; showAgentStoppedBar?: boolean; showAiCredits?: boolean; animatedStatusText?: boolean; codeLigatures?: boolean; showScrollbarMap?: boolean; stackedPullRequests?: boolean; typography?: { appScale: number; chatScale: number; codeScale: number }; showFinishedTurnTimes?: boolean; alarms?: Alarm[]; sessionNotificationSounds?: boolean; alarmSounds?: boolean;
  sessionListCollapse: SessionListCollapse; pullRequestsListWidthPx: number; rightPane: RightPaneSettings;
}
export interface SessionListCollapse { collapsedRepositoryIds: string[]; archivedOpen: boolean; showHidden: boolean; }
export const DEFAULT_SESSION_LIST_COLLAPSE: Readonly<SessionListCollapse> = Object.freeze({ collapsedRepositoryIds: [], archivedOpen: false, showHidden: false });
export { type TranscriptDisplaySettings, DEFAULT_TRANSCRIPT_DISPLAY } from './transcriptDisplay';

/** OMP model-role ids: built-in chat roles plus model-kind roles. */
export type ModelRoleId =
  | 'default'
  | 'smol'
  | 'slow'
  | 'vision'
  | 'plan'
  | 'commit'
  | 'tiny'
  | 'memory'
  | 'task'
  | 'advisor' | 'widget'
  | 'image'
  | 'web'
  | 'speech'
  | 'dictation'
  | 'judge';

/** Chat roles (`omp://models.md`): accept ordinary chat models (`tiny`/`memory` also accept `tiny`-catalog ones). */
export const CHAT_MODEL_ROLES: readonly ModelRoleId[] = ['default', 'smol', 'slow', 'vision', 'plan', 'commit', 'tiny', 'widget', 'memory', 'task', 'advisor'];

/** Model-kind roles (`omp://models.md`): each selects a different catalog kind's runner. */
export const MODEL_KIND_ROLES: readonly ModelRoleId[] = ['image', 'web', 'speech', 'dictation', 'judge'];

/** `omp models --kind <kind>` catalog groupings (`omp://models.md`). */
export type CatalogKind = 'chat' | 'tiny' | 'image' | 'tts' | 'stt' | 'search' | 'judge';

const CATALOG_KINDS: Record<string, true> = { chat: true, tiny: true, image: true, tts: true, stt: true, search: true, judge: true };

export function isCatalogKind(value: unknown): value is CatalogKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CATALOG_KINDS, value);
}

/** Which catalog kind each role's model picker queries. */
export const ROLE_CATALOG_KIND: Record<ModelRoleId, CatalogKind> = {
  default: 'chat',
  smol: 'chat',
  slow: 'chat',
  vision: 'chat',
  plan: 'chat',
  commit: 'chat',
  tiny: 'chat',
  memory: 'chat',
  task: 'chat',
  advisor: 'chat',
  widget: 'chat',
  image: 'image',
  web: 'search',
  speech: 'tts',
  dictation: 'stt',
  judge: 'judge',
};

/** Type guard preserving narrowing at the IPC boundary. */
export function isModelRoleId(value: unknown): value is ModelRoleId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ROLE_CATALOG_KIND, value);
}

/** One `omp models --kind <kind> --json` row. */
export interface ModelCatalogEntry {
  provider: string;
  id: string;
  selector: string;
  name: string;
  reasoning: boolean; thinking: string[] | null;
  /** OMP's reported context window; absent or null when OMP omits it. */
  contextWindow?: number | null;
}

/** Holds the two Session ids shown. */
export interface SplitLayout {
  sessionIds: [string, string];
  dividerPercent: number;
  focusedIndex: 0 | 1;
}

export const DEFAULT_SESSION_READOUT: Record<ReadoutKind, boolean> = {
  changes: true,
  'context-usage': true,
  'turn-time': true,
  'current-time': false,
  subagents: true,
  'todo-progress': true, 'current-work': true,
};

/** Maps Settings.approvalMode to the value OMP's `--approval-mode` flag expects. */
export const OMP_APPROVAL_MODE: Record<ApprovalMode, string> = {
  ask: 'always-ask',
  'ask-and-remember': 'always-ask-cached',
  'edit-freely': 'write',
  auto: 'yolo',
};

/** As direct as the word Stuart actually typed resuming his own crashed session ("resume"). */
export const DEFAULT_RESUME_INSTRUCTION = 'resume';

/** One record per running `omp` root process; the pid-and-start-time fallback for stale process reaping. */
export interface ProcessRecord {
  pid: number;
  startTime: string;
  sessionId: string;
}

/** The full contents of `registry.json`. */
export interface Registry {
  version: 1;
  repositories: Repository[];
  sessions: Session[];
}

export type SessionStatus = 'idle' | 'working' | 'needs-you' | 'stopped';

/** The staged ready-wait's default ceiling. */
export const READY_CEILING_MS = 180_000;

/** Absent once `start()` settles. */
export type SessionStartProgress =
  | { kind: 'queued' }
  | { kind: 'memory-deferred'; elapsedMs: number }
  | { kind: 'waiting' | 'prompt' | 'extended'; elapsedMs: number };

/** Held in memory: one per Session with a live or recently live agent. */
export interface SessionRuntime {
  sessionId: string;
  status: SessionStatus;
  stopReason?: 'agent-exited' | 'worktree-missing' | 'start-failed' | 'not-started';
  stopDetail?: string;
  startProgress?: SessionStartProgress;
  launchedMode: ApprovalMode;
  pendingMode: ApprovalMode | null;
  unread: boolean;
  transcript: TranscriptItem[];
  queue: { followUp: string[]; steering: string[] };
  pending: PendingRequest[];
  turnStartedAt: number | null;
  readout: SessionReadout;
  subagents: SubagentSummary[];
  /** A requested stop is never "terminated unexpectedly" by definition, regardless of what the Conversation's tail happens to show; readers must check this before re-deriving `terminatedUnexpectedly` from the tail. */
  stoppedOnRequest: boolean;
}

/** `partial` marks that the 200-file or 1 MiB-per-file cap stopped counting before the real total. */
export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
  partial: boolean;
}

export type PullRequestDisplayState = PullRequestState;
export type PullRequestChecks = 'pass' | 'fail' | 'pending';

export interface LinkedIssue {
  number: number;
  state: 'open' | 'closed' | 'unknown';
  title: string;
}

/** The Session branch's PR as the header badge shows it; `linkedIssues` are its closing issues. */
export interface SessionPullRequest {
  number: number;
  url: string;
  state: PullRequestDisplayState;
  checks: PullRequestChecks | null;
  linkedIssues: LinkedIssue[];
}

/** A PR or issue a Session wrote to through `gh`; `repositoryId` is the registered Project that owns it, else null. */
export interface TouchedRef {
  ownerRepo: string;
  repositoryId: string | null;
  kind: 'pr' | 'issue';
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged' | 'draft' | 'unknown';
  lastTouchedAt: number;
}

export interface SessionReadout extends ActivityReadoutFields {
  changes: DiffStat | 'not-available' | null; // DiffStat is spec 001 sessions.diffStat's return shape; null = not yet read
  contextUsage: ContextUsage | 'not-available' | null; aiCredits?: number | null;
  turnTime: { startedAt: number } | null;
  pullRequest: SessionPullRequest | null;
  subagentCount: { running: number; finished: number; exited: number; failed: number; cancelled: number } | null;
  todoTree: TodoPhase[] | null; branch?: { name: string; detached: boolean } | null;
  todoPhases: Array<{ name: string; pendingCount: number }> | null;
  /** Newest first; omitted when the Session has touched nothing. */
  touched?: TouchedRef[];
}

export interface ContextUsage {
  usedTokens: number;
  windowTokens: number;
  percent: number;
}

/** `id` is `${toolCallId}:${nameOrTask}`, plus a `:N` suffix when two members of one call share an identical name. */
export interface SubagentSummary {
  id: string;
  toolCallId: string;
  specIndex: number;
  nameOrTask: string;
  /** A freshly launched `OmpProcess` never reuses a previous one. Distinct from `failed`: nothing about the subagent's own work is known to have failed, only its process disappeared. */
  status: 'running' | 'finished' | 'failed' | 'cancelled' | 'exited' | 'parked';
  startedAt: number;
  durationMs?: number;
  taskSummary?: string;
  name?: string;
  background?: boolean;
}

/** One file or folder attached via the Attach button, drag-and-drop, or a clipboard file paste, parsed back out of the prompt text. */
export interface FileAttachmentRef {
  id: string;
  name: string;
  byteLength: number;
  sentAs: 'inline' | 'path';
  isDirectory: boolean;
}

/** Who sent a user turn when it was not Stuart: another Session's message (#1858). Absent for ordinary turns. */
export interface MessageSource {
  kind: 'session';
  sessionId: string;
  name: string;
}

/** Built in the main process from OMP frames; the renderer only renders items. */
export type TranscriptItem =
  | { kind: 'user'; id: string; text: string; at: number; fileAttachments?: FileAttachmentRef[]; images?: TranscriptImageRef[]; source?: MessageSource }
  | { kind: 'assistant-text'; id: string; text: string; streaming: boolean }
  | {
      kind: 'thinking';
      id: string;
      text: string;
      streaming: boolean;
      startedAt?: number;
      endedAt?: number;
    }
  | {
      kind: 'tool';
      id: string;
      toolCallId: string;
      tool: string;
      target: string;
      /** `'cancelled'`: the user's own Stop button cut a still-running call short, same family as a `subagent` item's own `'cancelled'` (#563 decision 15). */
      status: 'running' | 'done' | 'error' | 'interrupted' | 'cancelled';
      startedAt?: number;
      durationMs?: number;
      args: unknown;
      output?: string;
      diff?: string;
      details?: unknown;
      edit?: { path: string; oldText: string; newText: string };
      write?: { path: string; content: string };
      intent?: string;
      /** Set when this `read` call's target is a `skill://` URL: `name` is the URL's remainder after `skill://`. */
      skill?: { name: string };
    }
  | {
      kind: 'subagent';
      id: string;
      toolCallId: string;
      specIndex: number;
      name: string;
      task: string;
      context?: string;
      status: 'running' | 'done' | 'error' | 'cancelled' | 'exited' | 'parked';
      startedAt?: number;
      durationMs?: number;
      result?: string;
      /** The batch call's own `details.progress[].id`/the later `details.jobs[].jobId`, used only to correlate this row across the two frames; never rendered. */
      jobId?: string;
      messageId: string;
    }
  | {
      kind: 'agent-message';
      id: string;
      from: string;
      to: string;
      text: string;
      at: number; fromParent?: boolean; replyTo?: string;
    }
  | {
      kind: 'advisory';
      id: string;
      severity: 'nit' | 'concern' | 'blocker';
      advisor?: string;
      turnsAgo?: number;
      guidance?: string;
      text: string;
    }
  | { kind: 'request'; id: string; requestId: string; resolved?: 'approved' | 'denied' | 'answered' | 'cancelled' }
  | { kind: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string }
  | { kind: 'turn-error'; id: string; text: string }
  | {
      kind: 'skill-prompt';
      id: string;
      name: string;
      args?: string;
      lineCount?: number;
      /** The skill's own summary (front-matter `description`, else the first body paragraph) for the row's tooltip. */
      description?: string;
      text: string;
    };

/** Tool names the agent calls for its own bookkeeping. */
export const HIDDEN_TOOLS: ReadonlySet<string> = new Set(['todo']);

/** `id` prefix for the `notice` a hidden tool's failure becomes. */
export const HIDDEN_TOOL_NOTICE_PREFIX = 'hidden-tool-error:';

/** `id` prefix for a `notice` built from a `command_output`/`notice` frame that arrived before the user had taken any action. */
export const STARTUP_NOTICE_PREFIX = 'startup-notice:';

/** One question of an `ask`-tool batch. */
export interface AskQuestion { id: string; question: string; header?: string; options: { label: string; description?: string }[]; multi: boolean; recommended?: number; }

/** `requestId` is the `id` of the OMP `extension_ui_request`. */
export type PendingRequest =
  | { kind: 'approval'; requestId: string; tool: string; target: string; details: string[]; options?: string[] } // #1140: OMP's own option labels, answered verbatim
  | { kind: 'question'; requestId: string; title: string; message?: string; options: string[]; optionDetails?: (string | undefined)[]; inputKind: 'choice' | 'text' | 'confirm'; secret?: boolean }
  | { kind: 'ask'; requestId: string; questions: AskQuestion[]; deadlineAt?: number };

/** Derived from OMP by scanning `Session.sessionDir` for `*.jsonl` files; not stored by Refract. */
export interface ConversationInfo {
  file: string;
  id: string;
  createdAt: string;
  title: string;
  preview: string;
  isCurrent: boolean;
}

/** Refract never stores a GitHub access token. */
export interface ProfileCache {
  version: 1;
  accounts: Record<string, ProfileCacheEntry>;
}

export interface ProfileCacheEntry {
  displayName: string | null;
  avatarDataUrl: string | null;
  fetchedAt: string;
}

/** Relative to the Session's own worktree root. */
export type FileTreeEntryKind = 'file' | 'folder' | 'cannot-access';

export interface FileTreeNode {
  path: string;
  name: string;
  kind: FileTreeEntryKind;
  /** `undefined` means clean/untracked-and-not-shown, never "unknown". */
  gitStatus?: GitStatusMark;
}

export type GitStatusMark = 'modified' | 'added' | 'untracked' | 'deleted' | 'ignored' | 'renamed' | 'conflicted' | 'staged';

export type GitStatusMap = Record<string, GitStatusMark>;
export type { GitChangesGroupKind, GitChangesFileEntry, GitChangesHeader, GitChangesSnapshot } from './model-git-changes';
/** Replaced wholesale on every selection change. */
export type FilePreviewKind = 'text' | 'markdown' | 'image' | 'binary' | 'too-large' | 'deleted' | 'read-error';

export interface FilePreview {
  path: string;
  kind: FilePreviewKind;
  size?: number;
  content?: string;
  /** Detected by magic bytes, never by file extension. */
  base64?: string;
  mimeType?: string;
}
