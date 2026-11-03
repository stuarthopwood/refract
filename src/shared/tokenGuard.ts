/** Token guard (#1212, spec 021): the keys Refract sets in the `omp` launch overlay, their
 * grilled defaults (mirrored by `src-tauri/src/omp/token_guard/values.rs`), and the IPC payloads. */

export type TokenGuardValue = number | boolean | string | string[] | Record<string, string>;

export type TokenGuardValues = Record<string, TokenGuardValue>;

export interface TokenGuardSnapshot {
  values: TokenGuardValues;
  defaults: TokenGuardValues;
  /** Set on the one load after an upgrade dropped stored token thresholds (#1553). */
  thresholdsReset?: boolean;
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
 * trial order; `record`: per-model thresholds as `"N%"` strings. */
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
  /** Plain-language hint shown under the option name where the control has room for one. */
  description?: string;
}

/** Shown under a row when its value costs more than the default. `costlierWhen` gets the row's value
 * and default; a `record` row evaluates it per entry, with the entry's `"N%"` and the global
 * threshold as `"N%"`. */
export interface TokenGuardImpact {
  costlierWhen: (value: TokenGuardValue | undefined, defaultValue: TokenGuardValue | undefined) => boolean;
  text: string;
}

const above = (value: TokenGuardValue | undefined, defaultValue: TokenGuardValue | undefined): boolean =>
  typeof value === 'number' && typeof defaultValue === 'number' && value > defaultValue

const below = (value: TokenGuardValue | undefined, defaultValue: TokenGuardValue | undefined): boolean =>
  typeof value === 'number' && typeof defaultValue === 'number' && value < defaultValue

const setTo =
  (...targets: TokenGuardValue[]) =>
  (value: TokenGuardValue | undefined, defaultValue: TokenGuardValue | undefined): boolean =>
    value !== defaultValue && targets.includes(value as TokenGuardValue)

const COMPACTS_LATER_IMPACT = 'The conversation grows longer before it is compacted, so every call resends more tokens.'

export interface TokenGuardKeyInfo {
  key: string;
  label: string;
  kind: TokenGuardKind;
  group: TokenGuardGroup;
  /** Hand-written plain English; never OMP's own description text. */
  description: string;
  /** Count unit: shown after the field and in its accessible name. */
  unit?: string;
  /** Edited as a percent of the Default role model's window, stored as tokens (#1553). */
  percentOfWindow?: boolean;
  options?: readonly TokenGuardOption[];
  /** Key of the toggle that must be on for this row to apply. */
  dependsOn?: string;
  impact?: TokenGuardImpact;
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
  {
    value: 'remote',
    label: 'Remote',
    description: 'The model provider shortens the conversation on its own servers, when the provider supports it.'
  },
  {
    value: 'snapcompact',
    label: 'Snapcompact',
    description:
      'Saves old history as compact images the model reads back. Works only with models that can read images. No model call.'
  },
  { value: 'handoff', label: 'Handoff', description: 'Writes a handoff note and carries on from it as the summary.' },
  { value: 'soft', label: 'Soft', description: 'A model summarises the conversation in place.' },
  {
    value: 'shake',
    label: 'Shake',
    description:
      'Removes bulky content the agent can fetch again, such as old tool output and images. No model call.'
  }
];

/** Display order, group and plain-language text for the Settings > Advanced rows. The advisor model
 * (`modelRoles.advisor`) is edited under Models > Advisor, not here. */
export const TOKEN_GUARD_KEYS: readonly TokenGuardKeyInfo[] = [
  {
    key: 'compaction.thresholdPercent',
    label: 'Compaction threshold',
    kind: 'count',
    unit: '%',
    group: 'Context compaction',
    impact: { costlierWhen: above, text: COMPACTS_LATER_IMPACT },
    description:
      "Summarise the conversation when it fills this much of the model's context window, for models with no entry below."
  },
  {
    key: 'compaction.modelThresholds',
    label: 'Compaction threshold per model',
    kind: 'record',
    group: 'Context compaction',
    impact: {
      costlierWhen: (value, globalPercent) => Number.parseInt(String(value), 10) > Number.parseInt(String(globalPercent), 10),
      text: COMPACTS_LATER_IMPACT
    },
    description: "Per-model override of the threshold above, as a percent of that model's own context window."
  },
  {
    key: 'compaction.methodOrder',
    label: 'Compaction method order',
    kind: 'order',
    group: 'Context compaction',
    description:
      "How the agent shortens a long conversation. It tries the ticked methods from top to bottom and moves to the next one if a method can't run."
  },
  {
    key: 'compaction.idleEnabled',
    label: 'Compact when idle',
    kind: 'toggle',
    group: 'Idle compaction',
    description: 'Shorten the conversation while the Session waits for you, so your next message costs less.'
  },
  {
    key: 'compaction.idleThresholdTokens',
    label: 'Idle compaction threshold',
    kind: 'count',
    unit: 'tokens',
    percentOfWindow: true,
    group: 'Idle compaction',
    dependsOn: 'compaction.idleEnabled',
    description: 'Only do this when the conversation is at least this long.'
  },
  {
    key: 'compaction.idleTimeoutSeconds',
    label: 'Idle compaction delay',
    kind: 'count',
    unit: 'seconds',
    group: 'Idle compaction',
    dependsOn: 'compaction.idleEnabled',
    description: 'How long the Session waits with no activity before it shortens the conversation.'
  },
  {
    key: 'snapcompact.toolResults',
    label: 'Compress tool results to images',
    kind: 'toggle',
    group: 'Image compression',
    impact: {
      costlierWhen: setTo(false),
      text: 'Old tool results stay as text, which uses more tokens than the compressed images.'
    },
    description:
      'Turn long tool output into a compact image to use fewer tokens. Works only with models that can read images.'
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
      "Send the agent's instructions as a compact image to use fewer tokens. Works only with models that can read images. Text sent as an image can't be cached, so repeat requests may cost more."
  },
  {
    key: 'task.softRequestBudget',
    label: 'Subagent request budget',
    kind: 'count',
    unit: 'requests',
    group: 'Subagents',
    impact: {
      costlierWhen: (value, defaultValue) => above(value, defaultValue) || value === 0,
      text: 'Subagents may make more model calls before they are told to wrap up. With 0 there is no limit.'
    },
    description:
      'Limits how much each subagent can do. When it reaches this many model calls, it is asked to finish. At one and a half times this number, it is stopped. 0 means no limit.'
  },
  {
    key: 'task.maxConcurrency',
    label: 'Maximum parallel subagents',
    kind: 'count',
    unit: 'subagents',
    group: 'Subagents',
    description: 'How many subagents can run at once.'
  },
  {
    key: 'advisor.reviewMode',
    label: 'Advisor review mode',
    kind: 'enum',
    group: 'Advisor',
    options: [
      { value: 'turn', label: 'Every step' },
      { value: 'agent-end', label: 'Agent end' }
    ],
    impact: {
      costlierWhen: setTo('turn'),
      text: 'The advisor makes a model call on every step instead of once at the end.'
    },
    description: "How often the Advisor checks the agent's work: after every step, or once when the agent finishes."
  },
  {
    key: 'grep.contextBefore',
    label: 'Search context lines before',
    kind: 'count',
    unit: 'lines',
    group: 'Tool output',
    impact: {
      costlierWhen: above,
      text: 'Every search result gets longer, so each search adds more tokens to the conversation.'
    },
    description: 'Lines of surrounding text shown above each search match.'
  },
  {
    key: 'grep.contextAfter',
    label: 'Search context lines after',
    kind: 'count',
    unit: 'lines',
    group: 'Tool output',
    impact: {
      costlierWhen: above,
      text: 'Every search result gets longer, so each search adds more tokens to the conversation.'
    },
    description: 'Lines of surrounding text shown below each search match.'
  },
  {
    key: 'read.defaultLimit',
    label: 'File read line limit',
    kind: 'count',
    unit: 'lines',
    group: 'Tool output',
    impact: {
      costlierWhen: below,
      text: 'Reading a large file takes more calls at a lower limit, and each call costs a premium request.'
    },
    description: 'How many lines the agent sees when it opens a file without asking for a specific part.'
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
    impact: {
      costlierWhen: setTo('preferred', 'always'),
      text: 'The agent makes extra tool calls to keep a todo list.'
    },
    description:
      'How hard the agent is pushed to write a todo list after your first message. Stronger settings add model calls for creating and ticking off the list.'
  },
  {
    key: 'tools.artifactSpillThreshold',
    label: 'Tool output spill threshold',
    kind: 'count',
    unit: 'KB',
    group: 'Tool output',
    impact: {
      costlierWhen: above,
      text: 'More tool output stays in the conversation and is resent on every later call.'
    },
    description:
      "When a tool's output is bigger than this, the full output is saved to a file and the conversation keeps only the end of it."
  },
  {
    key: 'tools.xdev',
    label: 'Load rare tools on demand',
    kind: 'toggle',
    group: 'Tool output',
    impact: {
      costlierWhen: setTo(false),
      text: 'Every rare tool is loaded into the prompt, so each call sends more tokens.'
    },
    description: "Send rarely used tools only when they're needed, not with every request. Saves tokens."
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
    label: 'Extra turn to record lessons',
    kind: 'toggle',
    group: 'Learning',
    impact: { costlierWhen: setTo(true), text: 'Adds a model call after the agent records a lesson.' },
    description:
      'When a turn ends, the agent takes one extra hidden turn to save what it learned. This uses extra tokens.'
  }
];

