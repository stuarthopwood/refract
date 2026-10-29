// The Queued panel (#1145): queued messages as rows in a panel between the pinned Todo panel and
// the composer, so the next message to send sits next to Send. Built on the shared ComposerPanel;
// collapsed, the header names the next message. The scroller spans the pane so its scrollbar sits
// on the pane edge (#1130), with the row padding inside it.
import { ComposerPanel, ComposerPanelBody } from '@/components/ComposerPanel'
import { queuedChipDisplayText } from './imageOnlySend'
import { QueuedChipList } from './QueuedChipList'
import { useQueuedPanelCollapseStore, type QueuedMessages } from './useQueuedMessages'

export function QueuedPanel({ queued }: { queued: QueuedMessages }) {
  const { sessionId, chips } = queued
  const collapsed = useQueuedPanelCollapseStore((s) => s.collapsedBySession[sessionId] ?? false)
  const setCollapsed = useQueuedPanelCollapseStore((s) => s.setCollapsed)
  const next = chips[0]
  if (!next) return null
  const panelId = `queued-panel-${sessionId}`
  const listId = `${panelId}-list`
  const nextText = collapsed ? queuedChipDisplayText(next, queued.imageOnlyNames) : undefined

  return (
    <ComposerPanel
      id={panelId}
      slot="queued-panel"
      label="Queued messages"
      toggleLabel="Queued messages details"
      title={nextText ? `Queued \u00b7 ${chips.length} \u00b7 Next: ${nextText}` : `Queued \u00b7 ${chips.length}`}
      titleHint={nextText}
      collapsed={collapsed}
      onToggle={() => setCollapsed(sessionId, !collapsed)}
      bodyId={listId}
    >
      <ComposerPanelBody>
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
      </ComposerPanelBody>
    </ComposerPanel>
  )
}
