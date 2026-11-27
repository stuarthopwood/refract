import { NoteBadge } from '@/components/NoteBadge'
import { minimizedTooltip, truncatedTooltip, type BashOutputFacts } from './bashOutputMeta'

// On the row the badges are decorative: the row's accessible name carries the same sentences.
export function BashOutputBadges({ facts }: { facts: BashOutputFacts }) {
  if (!facts.truncated && !facts.minimized) return null
  return (
    <>
      {facts.truncated && <NoteBadge decorative label="Truncated" tooltip={truncatedTooltip(facts.truncated)} />}
      {facts.minimized && <NoteBadge decorative label="Minimized" tooltip={minimizedTooltip(facts.minimized)} />}
    </>
  )
}

// In the dialog the same facts read as visible sentences beside their badge, so nothing is hover-only.
export function BashOutputNotes({ facts }: { facts: BashOutputFacts }) {
  if (!facts.truncated && !facts.minimized) return null
  return (
    <ul aria-label="Output notes" className="space-y-1 text-xs text-muted-foreground">
      {facts.truncated && (
        <li className="flex items-center gap-2">
          <NoteBadge decorative label="Truncated" tooltip={truncatedTooltip(facts.truncated)} />
          <span>{truncatedTooltip(facts.truncated)}</span>
        </li>
      )}
      {facts.minimized && (
        <li className="flex items-center gap-2">
          <NoteBadge decorative label="Minimized" tooltip={minimizedTooltip(facts.minimized)} />
          <span>{minimizedTooltip(facts.minimized)}</span>
        </li>
      )}
    </ul>
  )
}
