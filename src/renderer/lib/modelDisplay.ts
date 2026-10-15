// Shared model/effort label helpers (T062/T063), used by both the session details card
// (SessionDetailsCard.tsx) and the message box (MessageInput.tsx) so the two surfaces never drift
// apart. Reads only `Session.lastModel`/`lastThinkingLevel` (T062): the persisted, registry-backed
// last-known values, never a separate live-only source.
import type { Session } from '../../shared/model'
import type { ThinkingLevel } from '../../shared/ipc-model'

// OMP's own `ThinkingLevel` string union (docs/spike/FINDINGS.md item 30): a closed set today,
// but an unrecognised future value still renders (falls back to the raw string) instead of
// disappearing.
export const THINKING_LEVEL_LABEL: Record<string, string> = {
  off: 'Off',
  inherit: 'Inherit',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

/** Display order for the Reasoning picker's menu (#564): OMP's own closed `ThinkingLevel` union
 * (`shared/ipc-model.ts`), so `handleSelect` below stays correctly typed -- deliberately NOT
 * derived from `Object.keys(THINKING_LEVEL_LABEL)`, which keys as plain `string` (that record
 * stays `Record<string, string>` on purpose, see its own comment above: it must also render an
 * unrecognised future value, which this closed menu list never offers to pick). */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'inherit', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** "provider/model-name" for a Session's last known model, or `null` before any `get_state`
 * has ever reported one (T063). Split so a surface rendering model and effort as two
 * separately-iconed chips (docs/DESIGN.md "No bracket/parenthetical UI copy") -- both
 * SessionDetailsCard.tsx and MessageInput.tsx -- never has to re-parse a combined string. */
export function formatModelLabel(session: Pick<Session, 'lastModel'>): string | null {
  if (!session.lastModel) return null
  const { provider, id, name } = session.lastModel
  return `${provider}/${name ?? id}`
}

/** The human label for a Session's last known thinking level, or `null` if none has been
 * reported yet. */
export function formatThinkingLevelLabel(session: Pick<Session, 'lastThinkingLevel'>): string | null {
  if (!session.lastThinkingLevel) return null
  // Security audit finding (2026-10-03, Low): a plain object literal lookup also returns
  // inherited Object.prototype properties for a key like "constructor" or "toString" --
  // `Object.hasOwn` keeps the fallback to the raw string for any key that isn't a real,
  // own-declared effort label.
  return Object.hasOwn(THINKING_LEVEL_LABEL, session.lastThinkingLevel)
    ? (THINKING_LEVEL_LABEL[session.lastThinkingLevel] ?? session.lastThinkingLevel)
    : session.lastThinkingLevel
}
