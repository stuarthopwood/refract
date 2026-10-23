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

export type TokenGuardKind = 'count' | 'toggle' | 'text' | 'list' | 'record';

export interface TokenGuardKeyInfo {
  key: string;
  label: string;
  kind: TokenGuardKind;
}

/** Display order and plain-language labels for the Settings > OMP rows. */
export const TOKEN_GUARD_KEYS: readonly TokenGuardKeyInfo[] = [
  { key: 'compaction.modelThresholds', label: 'Compaction threshold per model (tokens)', kind: 'record' },
  { key: 'compaction.thresholdTokens', label: 'Compaction threshold (tokens)', kind: 'count' },
  { key: 'compaction.idleEnabled', label: 'Compact when idle', kind: 'toggle' },
  { key: 'compaction.idleThresholdTokens', label: 'Idle compaction threshold (tokens)', kind: 'count' },
  { key: 'compaction.idleTimeoutSeconds', label: 'Idle compaction delay (seconds)', kind: 'count' },
  { key: 'compaction.methodOrder', label: 'Compaction method order', kind: 'list' },
  { key: 'snapcompact.toolResults', label: 'Compress tool results to images', kind: 'toggle' },
  { key: 'snapcompact.systemPrompt', label: 'Compress the system prompt', kind: 'text' },
  { key: 'task.softRequestBudget', label: 'Subagent request budget', kind: 'count' },
  { key: 'task.maxConcurrency', label: 'Maximum parallel subagents', kind: 'count' },
  { key: 'autolearn.autoContinue', label: 'Auto-continue after learning', kind: 'toggle' },
  { key: 'advisor.reviewMode', label: 'Advisor review mode', kind: 'text' },
  { key: 'modelRoles.advisor', label: 'Advisor model', kind: 'text' },
  { key: 'grep.contextBefore', label: 'Search context lines before', kind: 'count' },
  { key: 'grep.contextAfter', label: 'Search context lines after', kind: 'count' },
  { key: 'read.defaultLimit', label: 'File read line limit', kind: 'count' },
  { key: 'tools.artifactSpillThreshold', label: 'Tool output spill threshold', kind: 'count' },
  { key: 'tools.xdev', label: 'Cross-device tools', kind: 'toggle' },
];
