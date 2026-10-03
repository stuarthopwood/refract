// Shared "provider/model (effort)" readout (T062/T063), used by both the session details card
// (SessionDetailsCard.tsx) and the message box (MessageInput.tsx) so the two surfaces never drift
// apart. Reads only `Session.lastModel`/`lastThinkingLevel` (T062): the persisted, registry-backed
// last-known values, never a separate live-only source.
import type { Session } from '../../shared/model'

// OMP's own `ThinkingLevel` string union (docs/spike/FINDINGS.md item 30): a closed set today,
// but an unrecognised future value still renders (falls back to the raw string) instead of
// disappearing.
const THINKING_LEVEL_LABEL: Record<string, string> = {
 off: 'Off',
 inherit: 'Inherit',
 minimal: 'Minimal',
 low: 'Low',
 medium: 'Medium',
 high: 'High',
 xhigh: 'Extra high',
 max: 'Max'
}

/** "provider/model-name (Effort)" for a Session's last known model, or the documented
 * placeholder before any `get_state` has ever reported one (T063). */
export function formatModelReadout(session: Pick<Session, 'lastModel' | 'lastThinkingLevel'>): string {
 if (!session.lastModel) return 'Model not known yet'
 const { provider, id, name } = session.lastModel
 const label = `${provider}/${name ?? id}`
 if (!session.lastThinkingLevel) return label
 // Security audit finding (2026-10-03, Low): a plain object literal lookup also returns
 // inherited Object.prototype properties for a key like "constructor" or "toString" --
 // `Object.hasOwn` keeps the fallback to the raw string for any key that isn't a real,
 // own-declared effort label.
 const effort = Object.hasOwn(THINKING_LEVEL_LABEL, session.lastThinkingLevel)
  ? THINKING_LEVEL_LABEL[session.lastThinkingLevel]
  : session.lastThinkingLevel
 return `${label} (${effort})`
}
