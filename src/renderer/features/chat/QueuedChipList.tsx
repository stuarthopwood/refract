// The queued-message rows (issues #540, #591, #598, #1145): one full-width row per message, text
// truncated with the full text on hover, a ghost Send now (steering rows say they are already on
// their way) and a ghost Remove. Rendered by QueuedPanel; the handlers and focus bookkeeping live
// in useQueuedMessages.ts.
import type { FocusEvent as ReactFocusEvent, RefObject } from 'react'
import { XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { DerivedChip } from './queuedChips'
import { queuedChipDisplayText } from './imageOnlySend'

interface QueuedChipListProps {
  chips: readonly DerivedChip[]
  inFlightChips: ReadonlyMap<string, 'send' | 'remove'>
  imageOnlyNames: readonly string[] | undefined
  listRef: RefObject<HTMLUListElement | null>
  listId: string
  onFocus: (event: ReactFocusEvent<HTMLUListElement>) => void
  onBlur: (event: ReactFocusEvent<HTMLUListElement>) => void
  onSendNow: (chip: DerivedChip) => void
  onRemove: (chip: DerivedChip) => void
}

export function QueuedChipList({ chips, inFlightChips, imageOnlyNames, listRef, listId, onFocus, onBlur, onSendNow, onRemove }: QueuedChipListProps) {
  return (
    <ul ref={listRef} id={listId} aria-label="Queued message list" className="m-0 list-none p-0" onFocus={onFocus} onBlur={onBlur}>
      {chips.map((chip) => {
        const busyAction = inFlightChips.get(chip.key)
        const sendBusy = busyAction === 'send'
        const removeBusy = busyAction === 'remove'
        const anyBusy = busyAction != null
        const displayText = queuedChipDisplayText(chip, imageOnlyNames)
        const removeLabel = removeBusy ? `Removing queued message: ${displayText}` : `Remove queued message: ${displayText}`
        return (
          <li key={chip.key} data-chip-key={chip.key} className="flex h-8 items-center gap-2 px-4">
            <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={displayText}>
              {displayText}
            </span>
            {/* Send now only for a follow-up: OMP's `promote_queued_message` never matches a
             * steering message. The control stays a Button while busy so focus is never lost. */}
            {chip.queue === 'followUp' ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-chip-action="send"
                aria-label={sendBusy ? `Sending now: ${displayText}` : `Send now: ${displayText}`}
                aria-busy={sendBusy}
                aria-disabled={anyBusy}
                className="text-micro aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                onClick={() => {
                  if (anyBusy) return
                  onSendNow(chip)
                }}
              >
                {sendBusy ? 'Sending now…' : 'Send now'}
              </Button>
            ) : (
              <span className="shrink-0 px-1 text-micro text-muted-foreground">Sending at the next step</span>
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
                  className="text-muted-foreground hover:text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                  onClick={() => {
                    if (anyBusy) return
                    onRemove(chip)
                  }}
                >
                  <XIcon aria-hidden className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{removeLabel}</TooltipContent>
            </Tooltip>
          </li>
        )
      })}
    </ul>
  )
}
