// Shared model/effort label helpers (T062/T063), used by both the session details card
// (SessionDetailsCard.tsx) and the message box (MessageInput.tsx) so the two surfaces never drift
// apart. Reads only `Session.lastModel`/`lastThinkingLevel` (T062): the persisted, registry-backed
// last-known values, never a separate live-only source.
import type { Session } from '../../shared/model'
import type { ThinkingLevel } from '../../shared/ipc-model'

// OMP's own `ThinkingLevel` string union (docs/spike/FINDINGS.md item 30): a closed set today,
// but an unrecognised future value still renders (falls back to the raw string) instead of
// disappearing.
// 2026-10-15 grill (issue #564, decision 4): `inherit` reads "Default" -- it is omp's configured
// default for whichever model is active, not a separate named level -- and the Reasoning
// picker's menu lists every level in this exact order, Default first.
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

/** Display order for the Reasoning picker's menu (#564, decision 4: "Default (omp's inherit, the
 * configured default), Off, Minimal, Low, Medium, High, Extra high, Max"). OMP's own closed
 * `ThinkingLevel` union (`shared/ipc-model.ts`), so `handleSelect` below stays correctly typed --
 * deliberately NOT derived from `Object.keys(THINKING_LEVEL_LABEL)`, which keys as plain `string`
 * (that record stays `Record<string, string>` on purpose, see its own comment above: it must
 * also render an unrecognised future value, which this closed menu list never offers to pick). */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['inherit', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** "provider/model-name" for a Session's last known model, or `null` before any `get_state`
 * has ever reported one (T063). Split so a surface rendering model and effort as two
 * separately-iconed chips (docs/DESIGN.md "No bracket/parenthetical UI copy") -- both
 * SessionDetailsCard.tsx and MessageInput.tsx -- never has to re-parse a combined string. */
export function formatModelLabel(session: Pick<Session, 'lastModel'>): string | null {
  if (!session.lastModel) return null
  const { provider, id, name } = session.lastModel
  return `${provider}/${name ?? id}`
}

/** The human label for a Session's last known thinking level: `null` before any model has ever
 * been seen at all; "Reasoning not reported" (gate round 2, code-reviewer HIGH, corrected mid-
 * round by Stuart -- supersedes a wrong first attempt at this same fix that showed "Default"
 * here instead) once a model IS known but `lastThinkingLevel` itself is falsy -- covers BOTH a
 * Session where no level was ever explicitly requested, and one where a non-Default request was
 * explicitly made but this model did not confirm it back (`thinking_level.rs` explicitly clears
 * the field to `None` in that second case, so neither shows a stale previously-confirmed level).
 * "Default" is shown ONLY for the literal stored value `"inherit"` -- an explicit Default
 * request that `thinking_level.rs` persists directly, surviving later settles/relaunches even
 * though omp's own `get_state` never echoes it back; the resolved label otherwise. */
export function formatThinkingLevelLabel(session: Pick<Session, 'lastModel' | 'lastThinkingLevel'>): string | null {
  if (!session.lastModel) return null
  if (!session.lastThinkingLevel) return 'Reasoning not reported'
  // Security audit finding (2026-10-03, Low): a plain object literal lookup also returns
  // inherited Object.prototype properties for a key like "constructor" or "toString" --
  // `Object.hasOwn` keeps the fallback to the raw string for any key that isn't a real,
  // own-declared effort label.
  return Object.hasOwn(THINKING_LEVEL_LABEL, session.lastThinkingLevel)
    ? (THINKING_LEVEL_LABEL[session.lastThinkingLevel] ?? session.lastThinkingLevel)
    : session.lastThinkingLevel
}
