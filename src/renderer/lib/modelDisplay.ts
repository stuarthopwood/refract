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

/** The display NAME ONLY for a Session's last known model (#741 Part 1: the provider moves to a
 * place that doesn't need it at a glance -- the details card's own muted "via <Provider>" second
 * line, `@/lib/providerLabels`' `friendlyProviderLabel`, and (unchanged by this issue)
 * `ModelPicker.tsx`'s own Tooltip/accessible-name parenthetical, which builds its OWN
 * `provider/name` string locally rather than through this function now that this function's own
 * return shape dropped the provider). `null` before any `get_state` has ever reported a model
 * (T063). Built from the FIELDS (`name`/`id`), never by splitting a combined string on `/` -- an
 * id such as `openrouter/google/gemini` stays untouched either way. */
export function formatModelLabel(session: Pick<Session, 'lastModel'>): string | null {
  if (!session.lastModel) return null
  const { id, name } = session.lastModel
  // Gate round 7 fix (Flow Low, `agent://Arch877`): `name ?? id` kept an EMPTY-STRING `name`
  // (never actually seen from omp [INFERENCE], but not ruled out by the type) -- `?.trim() ||`
  // falls through to `id` for both `undefined`/`null` and a blank/whitespace-only string.
  return name?.trim() || id
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
