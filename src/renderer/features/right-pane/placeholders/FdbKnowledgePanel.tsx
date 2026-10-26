// FDB Knowledge placeholder panel (spec 013 FR-018 to FR-022, issue://393). Two states driven
// by `Settings.showSampleData` (T026, research.md decision 6): off (default) renders the honest
// three-part empty state from `docs/design/patterns.md` ("Empty-state shape") -- no Settings
// dependency beyond reading the flag itself, no network call, no stored state (FR-018). On
// renders believable, clearly labelled sample content instead (FR-021, `docs/design/patterns.md`
// "Placeholders and 'coming soon'"): each sample row carries its own visible "Sample data" badge
// (`SampleDataRow.tsx`, shared with `AgentBuilderPanel.tsx`), so no element is ever shown
// unlabelled (SC-006). The sample rows are inert (no `onClick`, no real search/ask/tool-call
// behaviour) -- there is nothing real behind them yet (FR-021: sample content is never mixed with
// real content), and a fake-but-interactive control would itself read as the "disabled control
// with a reason" pattern FR-019 forbids.
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
