// The "Compaction starts at" row text. Pure so the global/per-model wording is testable without rendering.
import type { TokenGuardTrigger } from '../../../../shared/tokenGuard'
import { formatCount } from './NumberUnitField'

export function formatTriggerLine(t: TokenGuardTrigger): string {
  // A per-model entry is a percent string ("80%") or a token count (number); only counts get thousands separators.
  const source = t.modelThreshold === undefined ? `${t.thresholdPercent}% global` : `${typeof t.modelThreshold === 'number' ? formatCount(t.modelThreshold) : t.modelThreshold} per-model`
  return `${t.model}: ${formatCount(t.triggerTokens)} tokens (${source} of ${formatCount(t.contextWindow)})`
}
