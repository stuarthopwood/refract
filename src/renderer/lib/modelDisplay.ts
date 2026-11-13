import type { Session } from '../../shared/model'
import type { ThinkingLevel } from '../../shared/ipc-model'

// OMP's `ThinkingLevel` union: an unrecognised future value falls back to the raw string. `inherit` reads "Default" (#564).
export const THINKING_LEVEL_LABEL: Record<string, string> = {
  inherit: 'Default',
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

/** Display order for the Reasoning picker's menu, Default first (#564). */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['inherit', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** What every model label says before any model has been seen for a Session (FR-064). */
export const MODEL_NOT_KNOWN = 'Model not known yet'

/** The display name only (no provider) for a Session's last known model (#741). */
export function formatModelLabel(session: Pick<Session, 'lastModel'>): string | null {
  if (!session.lastModel) return null
  const { id, name } = session.lastModel
  return name?.trim() || id
}

export function formatThinkingLevelLabel(session: Pick<Session, 'lastModel' | 'lastThinkingLevel'>): string | null {
  if (!session.lastModel) return null
  if (!session.lastThinkingLevel) return 'Reasoning not reported'
  // `Object.hasOwn`: a plain lookup would return inherited Object.prototype members for keys like "constructor".
  return Object.hasOwn(THINKING_LEVEL_LABEL, session.lastThinkingLevel)
    ? (THINKING_LEVEL_LABEL[session.lastThinkingLevel] ?? session.lastThinkingLevel)
    : session.lastThinkingLevel
}
