// The Queued panel (#1145): queued messages as rows in a panel between the pinned Todo panel and
// the composer, so the next message to send sits next to Send. Shaped like PinnedTodoPanel (header,
// per-Session collapse chevron, max height then scroll); the scroller spans the pane so its
// scrollbar sits on the pane edge (#1130), with the row padding inside it.
import { ChevronDownIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { COMPOSER_BUTTON_FOCUS_CLASS } from './pickerShared'
import { QueuedChipList } from './QueuedChipList'
import { useQueuedPanelCollapseStore, type QueuedMessages } from './useQueuedMessages'

export function QueuedPanel({ queued }: { queued: QueuedMessages }) {
  const { sessionId, chips } = queued
  const collapsed = useQueuedPanelCollapseStore((s) => s.collapsedBySession[sessionId] ?? false)
  const setCollapsed = useQueuedPanelCollapseStore((s) => s.setCollapsed)
  if (chips.length === 0) return null
  const panelId = `queued-panel-${sessionId}`
  const listId = `${panelId}-list`

  return (
    <section id={panelId} data-slot="queued-panel" aria-label="Queued messages" className="shrink-0 border-t border-divider py-2">
      <div className="flex h-6 items-center gap-1 px-4">
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">{`Queued \u00b7 ${chips.length}`}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-expanded={!collapsed}
              aria-controls={listId}
              aria-label="Queued messages details"
              aria-describedby={undefined}
              className={cn('aria-expanded:bg-transparent aria-expanded:text-muted-foreground', COMPOSER_BUTTON_FOCUS_CLASS)}
              onClick={() => setCollapsed(sessionId, !collapsed)}
            >
              <ChevronDownIcon aria-hidden className={cn('size-4 transition-transform', collapsed && '-rotate-90')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Queued messages details</TooltipContent>
        </Tooltip>
      </div>
      {!collapsed && (
        <div className="mt-1 max-h-[min(12rem,30vh)] overflow-y-auto [overflow-anchor:none]">
          <QueuedChipList
            chips={chips}
            inFlightChips={queued.inFlight}
            imageOnlyNames={queued.imageOnlyNames}
            listRef={queued.listRef}
            listId={listId}
            onFocus={queued.onFocus}
            onBlur={queued.onBlur}
            onSendNow={(chip) => void queued.sendNow(chip)}
            onRemove={(chip) => void queued.remove(chip)}
          />
        </div>
      )}
    </section>
  )
}
