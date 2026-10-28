// The queued-message chip row above the composer (issue #540, #591, #598), moved unchanged out
// of MessageInput.tsx (at its `check:file-size` baseline) when issue #744 added the image-only
// follow-up label ("Image (<filename>)", spec 009 FR-042). MessageInput keeps every handler and
// the focus bookkeeping; this component only renders.
import type { FocusEvent as ReactFocusEvent, RefObject } from 'react'
import { XIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { DerivedChip } from './queuedChips'
import { queuedChipDisplayText } from './imageOnlySend'

interface QueuedChipListProps {
  chips: readonly DerivedChip[]
  inFlightChips: ReadonlyMap<string, 'send' | 'remove'>
  imageOnlyNames: readonly string[] | undefined
  listRef: RefObject<HTMLUListElement | null>
  onFocus: (event: ReactFocusEvent<HTMLUListElement>) => void
  onBlur: (event: ReactFocusEvent<HTMLUListElement>) => void
  onSendNow: (chip: DerivedChip) => void
  onRemove: (chip: DerivedChip) => void
}

export function QueuedChipList({ chips, inFlightChips, imageOnlyNames, listRef, onFocus, onBlur, onSendNow, onRemove }: QueuedChipListProps) {
  return (
    <ul
      ref={listRef}
      aria-label="Queued messages"
      className="m-0 flex list-none flex-wrap gap-2 p-0"
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {chips.map((chip) => {
        const busyAction = inFlightChips.get(chip.key)
        const sendBusy = busyAction === 'send'
        const removeBusy = busyAction === 'remove'
        const anyBusy = busyAction != null
        const displayText = queuedChipDisplayText(chip, imageOnlyNames)
        const removeLabel = removeBusy ? `Removing queued message: ${displayText}` : `Remove queued message: ${displayText}`
        return (
          <li key={chip.key} data-chip-key={chip.key}>
            <Badge
              variant="secondary"
              className="h-auto max-w-full gap-2 overflow-visible py-1 pr-1"
            >
              <span className="max-w-64 truncate" title={displayText}>
                {displayText}
              </span>
              {/* Issue #540 (#591 cycle 3): Send now is offered only for a real follow-up
               * chip -- OMP's `promote_queued_message` only ever matches a queued
               * follow-up, so a steering chip's "Send now" could never succeed. A steering
               * chip instead shows a quiet status: it is already on its way to the agent's
               * next step. The control stays a `Button` throughout its busy state (never
               * swapped for inert text) so focus is never lost to the busy transition
               * itself. */}
              {chip.queue === 'followUp' ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  data-chip-action="send"
                  aria-label={sendBusy ? `Sending now: ${displayText}` : `Send now: ${displayText}`}
                  aria-busy={sendBusy}
                  aria-disabled={anyBusy}
                  className="rounded-full px-2 text-[0.7rem] aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                  onClick={() => {
                    if (anyBusy) return
                    onSendNow(chip)
                  }}
                >
                  {sendBusy ? 'Sending now…' : 'Send now'}
                </Button>
              ) : (
                <span className="px-1 text-[0.7rem] text-muted-foreground">Sending at the next step</span>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-chip-action="remove"
                    aria-label={removeLabel}
                    aria-busy={removeBusy}
                    aria-disabled={anyBusy}
                    className="rounded-full text-muted-foreground hover:text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                    onClick={() => {
                      if (anyBusy) return
                      onRemove(chip)
                    }}
                  >
                    <XIcon className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{removeLabel}</TooltipContent>
              </Tooltip>
            </Badge>
          </li>
        )
      })}
    </ul>
  )
}
