import { ChevronDownIcon, FileDiffIcon, FileIcon } from 'lucide-react'
import { IconButton } from '@/components/IconButton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { runBulkClose } from './document-tab-actions'
import { getPanelDescriptor } from './panel-registry'
import { bulkCloseEnabled, type TabItem } from './tab-items'

interface AllTabsMenuProps {
  sessionId: string | null
  items: readonly TabItem[]
  /** Display label per document tab id (same-name files already disambiguated). */
  labels: Readonly<Record<string, string>>
  activeKey: string | null
  onSelect: (item: TabItem) => void
}

/** Lists every tab, scrolled-off ones included, and holds the bulk close actions (FR-008, FR-029). */
export function AllTabsMenu({ sessionId, items, labels, activeKey, onSelect }: AllTabsMenuProps) {
  const enabled = bulkCloseEnabled(items, activeKey, sessionId !== null)
  const radioItems = (group: TabItem['kind'][]) =>
    items
      .filter((item) => group.includes(item.kind))
      .map((item) => {
        const Icon = item.kind === 'panel' ? getPanelDescriptor(item.id)?.icon : item.kind === 'file' ? FileIcon : FileDiffIcon
        const name = item.kind === 'panel' ? (getPanelDescriptor(item.id)?.name ?? item.id) : (labels[item.key] ?? item.tab.path)
        return (
          <DropdownMenuRadioItem key={item.key} value={item.key}>
            {Icon && <Icon aria-hidden className="size-4 text-muted-foreground" />}
            <span className="min-w-0 truncate">{name}</span>
          </DropdownMenuRadioItem>
        )
      })
  const section = (label: string, group: TabItem['kind'][]) =>
    items.some((item) => group.includes(item.kind)) && (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {radioItems(group)}
      </>
    )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="All tabs" data-all-tabs>
          <ChevronDownIcon aria-hidden className="size-4" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="flex max-h-80 flex-col">
        {/* Only the tab list scrolls; the bulk close actions stay pinned below it. */}
        <DropdownMenuRadioGroup
          className="min-h-0 overflow-y-auto"
          value={activeKey ?? ''}
          onValueChange={(key) => {
            const item = items.find((candidate) => candidate.key === key)
            if (item) onSelect(item)
          }}
        >
          {section('Panels', ['panel'])}
          {section('Files', ['file'])}
          {section('Diffs', ['diff'])}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!enabled.others} onSelect={() => sessionId && runBulkClose(sessionId, 'others', activeKey)}>
          Close others
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!enabled.all} onSelect={() => sessionId && runBulkClose(sessionId, 'all', null)}>
          Close all files and diffs
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!enabled.stale} onSelect={() => sessionId && runBulkClose(sessionId, 'stale', null)}>
          Close no-longer-changed tabs
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
