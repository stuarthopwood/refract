import { useMemo, useRef } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { XIcon } from 'lucide-react'
import { PANEL_HEADER_HEIGHT_CLASS, PanelHeader } from '@/components/PanelHeader'
import { splitDocumentPath } from '@/components/document-path'
import { IconButton } from '@/components/IconButton'
import { TabButton } from '@/components/TabButton'
import { Separator } from '@/components/ui/separator'
import { INSET_FOCUS_OUTLINE_CLASS } from '@/components/ui/focus-classes'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useEnterOnSwitch } from '@/components/useEnterOnSwitch'
import { cn } from '@/lib/utils'
import { useDocumentTabsStore, type DocumentTab } from '@/state/document-tabs-store'
import { useGitChangesStore } from '@/state/git-changes-store'
import { resolveActiveTab, useRightPaneStore } from '@/state/right-pane-store'
import { DiffStatCounts } from '../sessions/sessionDisplay'
import { compactPanelCount, documentTabIcon, formatPanelCount, getPanelDescriptor, splitPanelCount, tabItemName, usePanelCount, type PanelId } from './panel-registry'
import { closeHostedPanel } from './hosted-panel-actions'
import { AllTabsMenu } from './AllTabsMenu'
import { applyCloseResult } from './document-tab-actions'
import { documentTabAccessibleName, documentTabLabels } from './document-tab-labels'
import { EMPTY_PANE_FOCUS_SELECTORS, firstMatch } from './pane-focus-targets'
import { useRevealActiveTab } from './useRevealActiveTab'
import { useSessionDocumentTabs } from './useSessionDocumentTabs'
import { activeItemKey, buildTabItems, closeButtonLabel, tabDomIds, tabKeyAction, type TabItem } from './tab-items'

// Below this tablist width (pane under about 424 px) panel tabs go icon-only and document tabs and counts shrink: 24rem is
// what two full-label panel tabs (259 px) + separator (17 px) + the 96 px document floor need.
const COMPACT_HIDE = '@max-[24rem]:hidden'
// A panel item shrinks no lower than its tab's min-w-15 (60 px) plus the 24 px close button; icon-only it is 32 + 24 px and never shrinks.
const PANEL_ITEM_CLASS = 'min-w-21 shrink @max-[24rem]:min-w-0 @max-[24rem]:shrink-0'
// 96 px = the narrowest document item (min-w-18 tab, 72 px, plus its 24 px close button), so the active tab always fits whole.
// Vertical overflow is clipped: the close buttons' enlarged hit areas would otherwise make the strip scroll up and down.
const DOCUMENT_SCROLLER_CLASS = 'relative flex min-w-24 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]'
// Panels give way before documents; the group scrolls on its own when even icon-only tabs do not fit.
const PANEL_GROUP_CLASS = 'relative flex min-w-0 shrink items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]'
// 24 px button; the pseudo-element stretches the hit area to the 40 px strip (FR-007).
const CLOSE_BUTTON_CLASS =
  "relative after:absolute after:-inset-y-2 after:inset-x-0 after:content-[''] transition-none text-muted-foreground hover:text-foreground focus-visible:text-foreground " + INSET_FOCUS_OUTLINE_CLASS

interface PanelTabBarProps {
  sessionId: string | null
}

interface TabButtonCommon {
  selected: boolean
  tabRef: (el: HTMLButtonElement | null) => void
  onSelect: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  onAuxClick: (event: React.MouseEvent<HTMLButtonElement>) => void
}

export function PanelTabBar({ sessionId }: PanelTabBarProps) {
  const openPanelIds = useRightPaneStore((s) => s.openPanelIds)
  const activePanelId = useRightPaneStore((s) => s.activePanelId)
  const activateTab = useRightPaneStore((s) => s.activateTab)
  const documents = useSessionDocumentTabs(sessionId)
  const documentTabs = documents.tabs
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const wrapperRef = useRef<HTMLDivElement>(null)
  const activeKey = activeItemKey(resolveActiveTab(sessionId, activePanelId, documents))
  const tabListRef = useEnterOnSwitch<HTMLDivElement>(activeKey, 'tabs')
  const documentScrollerRef = useRef<HTMLDivElement>(null)
  const panelScrollerRef = useRef<HTMLDivElement>(null)
  const scrollerRefs = useMemo(() => [panelScrollerRef, documentScrollerRef], [])
  const items = useMemo(() => buildTabItems(openPanelIds, documentTabs), [openPanelIds, documentTabs])
  const labels = useMemo(() => {
    const labelList = documentTabLabels(documentTabs)
    return Object.fromEntries(documentTabs.map((tab, index) => [tab.id, labelList[index] ?? tab.path]))
  }, [documentTabs])

  useRevealActiveTab({ activeKey, itemCount: items.length, tabRefs, scrollerRefs })

  function select(item: TabItem): void {
    if (item.kind === 'panel') activateTab({ kind: 'panel', id: item.id }, sessionId)
    else if (sessionId) activateTab({ kind: 'document', sessionId, id: item.tab.id })
  }

  function closeItem(item: TabItem): void {
    const remaining = items.length - 1
    if (item.kind === 'panel') closeHostedPanel(item.id, { skipFocusFallback: true })
    else if (sessionId) applyCloseResult(sessionId, useDocumentTabsStore.getState().closeDocumentTab(sessionId, item.tab.id))
    requestAnimationFrame(() => {
      if (remaining === 1) return wrapperRef.current?.querySelector<HTMLElement>('[data-panel-close]')?.focus()
      // The strip is gone and the launcher shows; without a target focus would fall to the body.
      if (remaining === 0) return firstMatch(EMPTY_PANE_FOCUS_SELECTORS, (selector) => document.querySelector<HTMLElement>(selector))?.focus()
      const next = activeItemKey(resolveActiveTab(sessionId, useRightPaneStore.getState().activePanelId, sessionId ? useDocumentTabsStore.getState().bySession[sessionId] : undefined))
      if (next) tabRefs.current[next]?.focus()
    })
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>, item: TabItem): void {
    const action = tabKeyAction(items, items.indexOf(item), event.key)
    if (!action) return
    event.preventDefault()
    if (action.kind === 'close') return closeItem(item)
    select(action.item)
    tabRefs.current[action.item.key]?.focus()
  }

  return (
    <PanelTabStrip
      sessionId={sessionId}
      items={items}
      labels={labels}
      activeKey={activeKey}
      wrapperRef={wrapperRef}
      tabListRef={tabListRef}
      documentScrollerRef={documentScrollerRef}
      panelScrollerRef={panelScrollerRef}
      tabRefs={tabRefs}
      onSelect={select}
      onClose={closeItem}
      onKeyDown={handleKeyDown}
    />
  )
}

interface PanelTabStripProps {
  sessionId: string | null
  items: readonly TabItem[]
  /** Display label per document tab id (same-name files already disambiguated). */
  labels: Readonly<Record<string, string>>
  activeKey: string | null
  wrapperRef: RefObject<HTMLDivElement | null>
  tabListRef: RefObject<HTMLDivElement | null>
  /** The document tabs' own scroller; panel tabs sit outside it, pinned left (FR-008). */
  documentScrollerRef: RefObject<HTMLDivElement | null>
  /** The pinned panel group's own scroller, for when icon-only panel tabs still overflow. */
  panelScrollerRef: RefObject<HTMLDivElement | null>
  tabRefs: RefObject<Record<string, HTMLButtonElement | null>>
  onSelect: (item: TabItem) => void
  onClose: (item: TabItem) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>, item: TabItem) => void
}

/** Store-free view of the strip, so the layout renders without a DOM. */
export function PanelTabStrip({ sessionId, items, labels, activeKey, wrapperRef, tabListRef, documentScrollerRef, panelScrollerRef, tabRefs, onSelect, onClose, onKeyDown }: PanelTabStripProps) {
  const only = items.length === 1 ? items[0] : undefined
  if (only) {
    const title = only.kind === 'panel' ? tabItemName(only, labels) : null
    const fullPath = only.kind === 'panel' ? null : only.tab.path
    const path = fullPath === null ? null : splitDocumentPath(fullPath)
    return (
      <div className="flex shrink-0 flex-col">
        <PanelHeader
          ref={wrapperRef}
          actions={
            <IconButton label={closeButtonLabel(only, tabItemName(only, labels))} data-panel-close onClick={() => onClose(only)}>
              <XIcon aria-hidden className="size-4" />
            </IconButton>
          }
        >
          {path ? (
            // The folder gives way first so the file name stays readable; the full path is the tooltip.
            <h2 id="right-pane-panel-title" title={fullPath ?? undefined} className="flex min-w-0 text-sm font-medium">
              {path.directory && <span className="min-w-0 truncate text-muted-foreground">{`${path.directory}/`}</span>}
              <span className="max-w-full shrink-0 truncate">{path.name}</span>
            </h2>
          ) : (
            <h2 id="right-pane-panel-title" className="min-w-0 truncate text-sm font-medium">
              {title}
            </h2>
          )}
        </PanelHeader>
      </div>
    )
  }

  const renderItem = (item: TabItem) => {
    const selected = item.key === activeKey
    const common: TabButtonCommon = {
      selected,
      tabRef: (el) => {
        if (tabRefs.current) tabRefs.current[item.key] = el
      },
      onSelect: () => onSelect(item),
      onKeyDown: (event) => onKeyDown(event, item),
      onAuxClick: (event) => {
        if (event.button !== 1) return
        event.preventDefault()
        onClose(item)
      }
    }
    return (
      <div key={item.key} role="presentation" className={cn('flex items-center', item.kind === 'panel' ? PANEL_ITEM_CLASS : 'max-w-full shrink-0')}>
        {item.kind === 'panel' ? (
          <PanelTabButton id={item.id} sessionId={sessionId} {...common} />
        ) : (
          <DocumentTabButton tab={item.tab} label={labels[item.key] ?? item.tab.path} sessionId={sessionId} {...common} />
        )}
        <IconButton
          label={closeButtonLabel(item, tabItemName(item, labels))}
          shortcut={['Delete']}
          tabIndex={selected ? 0 : -1}
          data-panel-close
          className={cn(CLOSE_BUTTON_CLASS, selected && 'text-foreground')}
          onClick={() => onClose(item)}
          onKeyDown={(event) => onKeyDown(event, item)}
        >
          <XIcon aria-hidden className="size-4" />
        </IconButton>
      </div>
    )
  }
  const panelItems = items.filter((item) => item.kind === 'panel')
  const documentItems = items.filter((item) => item.kind !== 'panel')

  return (
    <div className="flex shrink-0 flex-col">
      <div ref={wrapperRef} className={cn('no-drag-region flex shrink-0 items-center gap-1 px-2', PANEL_HEADER_HEIGHT_CLASS)}>
        <div ref={tabListRef} role="tablist" aria-label="Open tabs" className="@container flex min-w-0 flex-1 items-center gap-1">
          {panelItems.length > 0 && (
            <div ref={panelScrollerRef} role="presentation" className={PANEL_GROUP_CLASS}>
              {panelItems.map(renderItem)}
            </div>
          )}
          {panelItems.length > 0 && documentItems.length > 0 && <Separator orientation="vertical" className="mx-1 h-4 shrink-0" />}
          {documentItems.length > 0 && (
            <div ref={documentScrollerRef} role="presentation" className={DOCUMENT_SCROLLER_CLASS}>
              {documentItems.map(renderItem)}
            </div>
          )}
        </div>
        <AllTabsMenu sessionId={sessionId} items={items} labels={labels} activeKey={activeKey} onSelect={onSelect} />
      </div>
    </div>
  )
}

interface DocumentTabButtonProps extends TabButtonCommon {
  tab: DocumentTab
  label: string
  sessionId: string | null
}

function DocumentTabButton({ tab, label, sessionId, selected, tabRef, onSelect, onKeyDown, onAuxClick }: DocumentTabButtonProps) {
  const counts = useGitChangesStore((s) =>
    tab.kind === 'diff' && sessionId ? (s.bySession[sessionId]?.snapshot?.groups[tab.group].find((entry) => entry.path === tab.path) ?? null) : null
  )
  const Icon = documentTabIcon(tab.kind)
  const ids = sessionId ? tabDomIds({ kind: 'document', sessionId, id: tab.id }) : null
  return (
    <Tooltip>
      <TooltipTrigger asChild aria-describedby={undefined}>
        <TabButton
          ref={tabRef}
          ids={ids}
          selected={selected}
          aria-label={documentTabAccessibleName(tab, label, counts ?? undefined)}
          className={cn(
            'min-w-18 max-w-48 shrink @min-[24rem]:min-w-28 @min-[24rem]:shrink-0',
            tab.dead && 'italic text-muted-foreground aria-selected:text-muted-foreground'
          )}
          onClick={onSelect}
          onKeyDown={onKeyDown}
          onAuxClick={onAuxClick}
        >
          <Icon aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 shrink-[100] truncate">{label}</span>
          {counts && (
            <span className={cn('shrink-0 text-xs', COMPACT_HIDE)}>
              <DiffStatCounts added={counts.additions} removed={counts.deletions} />
            </span>
          )}
        </TabButton>
      </TooltipTrigger>
      <TooltipContent>{tab.path}</TooltipContent>
    </Tooltip>
  )
}

interface PanelTabButtonProps extends TabButtonCommon {
  id: PanelId
  sessionId: string | null
}

function PanelTabButton({ id, sessionId, selected, tabRef, onSelect, onKeyDown, onAuxClick }: PanelTabButtonProps) {
  const descriptor = getPanelDescriptor(id)
  const count = usePanelCount(id, sessionId)
  if (!descriptor) return null
  const Icon = descriptor.icon
  const countText = count ? formatPanelCount(count) : undefined
  const fullLabel = `${descriptor.name}${countText ? ` ${countText}` : ''}`
  // The compact Git tab leads with the changed-files figure in its accessible name (WCAG 2.5.3).
  const accessibleLabel =
    count?.kind === 'additions-deletions'
      ? `${descriptor.name}, ${count.files} ${count.files === 1 ? 'file' : 'files'}, ${count.additions} ${count.additions === 1 ? 'addition' : 'additions'}, ${count.deletions} ${count.deletions === 1 ? 'deletion' : 'deletions'}`
      : fullLabel
  const parts = splitPanelCount(count)
  const runningCls = count?.kind === 'running' ? 'text-state-working' : undefined
  const compactCount = compactPanelCount(count)
  return (
    <Tooltip>
      <TooltipTrigger asChild aria-describedby={undefined}>
        <TabButton
          ref={tabRef}
          ids={tabDomIds({ kind: 'panel', id })}
          selected={selected}
          aria-label={countText ? accessibleLabel : undefined}
          className="min-w-15 shrink @max-[24rem]:min-w-0 @max-[24rem]:shrink-0"
          onClick={onSelect}
          onKeyDown={onKeyDown}
          onAuxClick={onAuxClick}
        >
          <Icon aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 shrink-[100] truncate @max-[24rem]:sr-only">{descriptor.name}</span>
          {count?.kind === 'additions-deletions' ? (
            <span className={cn('shrink-0 text-xs', COMPACT_HIDE)}>
              <DiffStatCounts added={count.additions} removed={count.deletions} accessibleLabel />
            </span>
          ) : (
            countText && <span className={cn('shrink-0 tabular-nums', COMPACT_HIDE, runningCls)}>{parts?.number}</span>
          )}
          {parts?.word && <span className={cn('min-w-0 shrink-[1000] truncate', COMPACT_HIDE, runningCls)}>{parts.word}</span>}
          {compactCount && (
            <span aria-hidden className={cn('hidden shrink-0 text-xs tabular-nums @max-[24rem]:inline', runningCls)}>
              {compactCount}
            </span>
          )}
        </TabButton>
      </TooltipTrigger>
      <TooltipContent>{fullLabel}</TooltipContent>
    </Tooltip>
  )
}
