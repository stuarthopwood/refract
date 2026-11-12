// The "Compaction starts at" row text. Pure so the global/per-model wording is testable without rendering.
import { formatThreshold, parseThreshold, type TokenGuardTrigger } from '../../../../shared/tokenGuard'
import { formatCount } from './NumberUnitField'

// A bare number follows OMP: up to 99 is a percent, larger is a token count; strings ("80%") show as written.
function formatModelThreshold(value: string | number): string {
  if (typeof value === 'string') return value
  const shown = formatThreshold(parseThreshold(value))
  return typeof shown === 'number' ? formatCount(shown) : shown
}

export function formatTriggerLine(t: TokenGuardTrigger): string {
  const source = t.modelThreshold === undefined ? `${t.thresholdPercent}% global` : `${formatModelThreshold(t.modelThreshold)} per-model`
  return `${t.model}: ${formatCount(t.triggerTokens)} tokens (${source} of ${formatCount(t.contextWindow)})`
}
