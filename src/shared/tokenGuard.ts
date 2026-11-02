/** Token guard (#1212, spec 021): the keys Refract sets in the `omp` launch overlay, their
 * grilled defaults (mirrored by `src-tauri/src/omp/token_guard/values.rs`), and the IPC payloads. */

export type TokenGuardValue = number | boolean | string | string[] | Record<string, number>;

export type TokenGuardValues = Record<string, TokenGuardValue>;

export interface TokenGuardSnapshot {
  values: TokenGuardValues;
  defaults: TokenGuardValues;
}

export interface TokenGuardLaunchWarning {
  sessionId?: string;
  reason: string;
}

/** `token-guard:calls`: model calls in a Session's current Conversation. */
export interface TokenGuardCalls {
  sessionId: string;
  conversationId: string;
  calls: number;
}

export type TokenGuardHandoffResult = { ok: true } | { ok: false; reason: string };

/** Calls at which the Status line offers a Hand off, and the pane banner repeats it. */
export const LONG_CONVERSATION_CALLS = 300;
export const LONG_CONVERSATION_BANNER_CALLS = 500;
/** A dismissed banner returns after this many more calls. */
export const LONG_CONVERSATION_BANNER_REPEAT = 100;

/** `count`: whole number with a unit; `enum`: one of `options`; `order`: the compaction methods in
 * trial order; `record`: per-model token thresholds. */
export type TokenGuardKind = 'count' | 'toggle' | 'enum' | 'order' | 'record';

export type TokenGuardGroup =
  | 'Context compaction'
  | 'Idle compaction'
  | 'Image compression'
  | 'Subagents'
  | 'Advisor'
  | 'Tool output'
  | 'Session start'
  | 'Learning'

export interface TokenGuardOption {
  value: string;
  label: string;
}

export interface TokenGuardKeyInfo {
  key: string;
  label: string;
  kind: TokenGuardKind;
  group: TokenGuardGroup;
  /** Hand-written plain English; never OMP's own description text. */
  description: string;
  /** Count unit: shown after the field and in its accessible name. */
  unit?: string;
  options?: readonly TokenGuardOption[];
  /** Key of the toggle that must be on for this row to apply. */
  dependsOn?: string;
}

export const TOKEN_GUARD_GROUPS: readonly TokenGuardGroup[] = [
  'Context compaction',
  'Idle compaction',
  'Image compression',
  'Subagents',
  'Advisor',
  'Tool output',
  'Session start',
  'Learning'
]

/** The compaction methods OMP knows, in display order for methods not yet in the saved order. */
export const COMPACTION_METHODS: readonly TokenGuardOption[] = [
  { value: 'remote', label: 'Remote' },
  { value: 'snapcompact', label: 'Snapcompact' },
  { value: 'handoff', label: 'Handoff' },
  { value: 'soft', label: 'Soft' },
  { value: 'shake', label: 'Shake' }
];

/** Display order, group and plain-language text for the Settings > Advanced rows. The advisor model
 * (`modelRoles.advisor`) is edited under Models > Advisor, not here. */
export const TOKEN_GUARD_KEYS: readonly TokenGuardKeyInfo[] = [
  {
    key: 'compaction.thresholdTokens',
    label: 'Compaction threshold',
    kind: 'count',
    unit: 'tokens',
    group: 'Context compaction',
    description: 'Summarise the conversation when it reaches this many tokens, for models with no entry below.'
  },
  {
    key: 'compaction.modelThresholds',
    label: 'Compaction threshold per model',
    kind: 'record',
    group: 'Context compaction',
    description: 'Per-model override of the threshold above.'
  },
  {
    key: 'compaction.methodOrder',
    label: 'Compaction method order',
    kind: 'order',
    group: 'Context compaction',
    description:
      'The ways OMP tries to shrink a long conversation, in order. If one is unavailable or fails, the next is used.'
  },
  {
    key: 'compaction.idleEnabled',
    label: 'Compact when idle',
    kind: 'toggle',
    group: 'Idle compaction',
    description: 'Shrink the conversation while the Session is waiting for you, so the next turn starts smaller.'
  },
  {
    key: 'compaction.idleThresholdTokens',
    label: 'Idle compaction threshold',
    kind: 'count',
    unit: 'tokens',
    group: 'Idle compaction',
    dependsOn: 'compaction.idleEnabled',
    description: 'Only compact when idle if the conversation is at least this big.'
  },
  {
    key: 'compaction.idleTimeoutSeconds',
    label: 'Idle compaction delay',
    kind: 'count',
    unit: 'seconds',
    group: 'Idle compaction',
    dependsOn: 'compaction.idleEnabled',
    description: 'How long the Session must be idle before it compacts.'
  },
  {
    key: 'snapcompact.toolResults',
    label: 'Compress tool results to images',
    kind: 'toggle',
    group: 'Image compression',
    description: 'Store long tool output as a dense image instead of text (vision models only). Saves tokens.'
  },
  {
    key: 'snapcompact.systemPrompt',
    label: 'Compress the system prompt to images',
    kind: 'enum',
    group: 'Image compression',
    options: [
      { value: 'none', label: 'None' },
      { value: 'agents-md', label: 'AGENTS.md only' },
      { value: 'all', label: 'All' }
    ],
    description:
      'Send instructions as dense images instead of text (vision models only). Saves tokens but loses prompt caching for that text.'
  },
  {
    key: 'task.softRequestBudget',
    label: 'Subagent request budget',
    kind: 'count',
    unit: 'requests',
    group: 'Subagents',
    description:
      'Model calls a subagent may make before it is told to wrap up; at 1.5 times this it is stopped. 0 means no limit.'
  },
  {
    key: 'task.maxConcurrency',
    label: 'Maximum parallel subagents',
    kind: 'count',
    unit: 'subagents',
    group: 'Subagents',
    description: 'How many subagents may run at the same time.'
  },
  {
    key: 'advisor.reviewMode',
    label: 'Advisor review mode',
    kind: 'enum',
    group: 'Advisor',
    options: [
      { value: 'turn', label: 'Every turn' },
      { value: 'agent-end', label: 'Agent end' }
    ],
    description: "When the Advisor reviews the agent's work: after every turn, or only when the agent finishes."
  },
  {
    key: 'grep.contextBefore',
    label: 'Search context lines before',
    kind: 'count',
    unit: 'lines',
    group: 'Tool output',
    description: 'Lines shown before each search match.'
  },
  {
    key: 'grep.contextAfter',
    label: 'Search context lines after',
    kind: 'count',
    unit: 'lines',
    group: 'Tool output',
    description: 'Lines shown after each search match.'
  },
  {
    key: 'read.defaultLimit',
    label: 'File read line limit',
    kind: 'count',
    unit: 'lines',
    group: 'Tool output',
    description: 'Lines returned when the agent reads a file without asking for a range.'
  },
  {
    key: 'read.summarize.enabled',
    label: 'Summarise files on read',
    kind: 'toggle',
    group: 'Tool output',
    description:
      'Return a structural outline instead of the file body when the agent reads a file without a range. Off means the agent sees the code in one read, which saves follow-up model calls.'
  },
  {
    key: 'todo.eager',
    label: 'Automatic todo lists',
    kind: 'enum',
    group: 'Tool output',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'preferred', label: 'Preferred' },
      { value: 'always', label: 'Always' }
    ],
    description:
      'How hard the agent is pushed to write a todo list after your first message. Stronger settings add model calls for creating and ticking off the list.'
  },
  {
    key: 'tools.artifactSpillThreshold',
    label: 'Tool output spill threshold',
    kind: 'count',
    unit: 'KB',
    group: 'Tool output',
    description: 'Tool output larger than this is saved to a file and only its end is kept in the conversation.'
  },
  {
    key: 'tools.xdev',
    label: 'Cross-device tools',
    kind: 'toggle',
    group: 'Tool output',
    description:
      'Load rarely used tools on demand instead of sending their definitions with every request. Saves tokens.'
  },
  {
    key: 'prewalk.enabled',
    label: 'Start Sessions with prewalk',
    kind: 'toggle',
    group: 'Session start',
    description:
      'Switch to a cheaper model at the first file edit. When off, prewalk also stops judging each new task. You can still arm it for one Session from its menu.'
  },
  {
    key: 'plan.defaultOnStartup',
    label: 'Start in plan mode',
    kind: 'toggle',
    group: 'Session start',
    description: 'New Sessions begin in plan mode: the agent plans and asks before it changes files.'
  },
  {
    key: 'autolearn.autoContinue',
    label: 'Auto-continue after learning',
    kind: 'toggle',
    group: 'Learning',
    description: 'After a turn ends, run one extra private turn to record what was learned. Uses extra tokens.'
  }
];

