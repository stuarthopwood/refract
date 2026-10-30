import { MessageCircleIcon, SearchIcon, WrenchIcon, LibraryIcon } from 'lucide-react'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { useSettingsStore } from '@/state'
import { SampleDataRow, type SampleDataRowProps } from './SampleDataRow'

type SampleRow = Pick<SampleDataRowProps, 'icon' | 'text'>

const SAMPLE_SEARCHES: SampleRow[] = [
  { icon: SearchIcon, text: 'Paracetamol max dose' },
  { icon: SearchIcon, text: 'Warfarin interactions' }
]

const SAMPLE_ASKS: SampleRow[] = [{ icon: MessageCircleIcon, text: 'Amoxicillin interactions' }]

const SAMPLE_TOOLS: SampleRow[] = [
  { icon: WrenchIcon, text: 'drug_interactions' },
  { icon: WrenchIcon, text: 'search_bnf_monograph' }
]

function SampleSection({ heading, rows }: { heading: string; rows: SampleRow[] }) {
  return (
    <div>
      <h3 className="mb-1 text-xs text-muted-foreground uppercase tracking-wide">{heading}</h3>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <SampleDataRow key={row.text} icon={row.icon} text={row.text} />
        ))}
      </ul>
    </div>
  )
}

/** Placeholder panel: empty state, or inert labelled sample rows when `showSampleData` is on. */
export function FdbKnowledgePanel() {
  const showSampleData = useSettingsStore((state) => state.settings.showSampleData)

  if (!showSampleData) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LibraryIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>FDB Knowledge isn't connected yet</EmptyTitle>
          <EmptyDescription>Waiting on the FDB Knowledge integration.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <SampleSection heading="Recent searches" rows={SAMPLE_SEARCHES} />
      <SampleSection heading="Ask" rows={SAMPLE_ASKS} />
      <SampleSection heading="Agent tools" rows={SAMPLE_TOOLS} />
    </div>
  )
}
