// Agent Builder placeholder panel (spec 013 FR-018 to FR-022, issue://393). Same two-state shape
// as `FdbKnowledgePanel.tsx` (T027, research.md decision 6): off (default) renders the honest
// three-part empty state; on renders believable, clearly labelled sample cloud-agent content
// instead, each row carrying its own visible "Sample data" badge (`SampleDataRow.tsx`, shared
// with `FdbKnowledgePanel.tsx`, FR-021, SC-006). Inert for the same reason `FdbKnowledgePanel.tsx`
// documents -- nothing real exists behind this panel yet. Sample names are kept short (A11y1
// gate Low) so they fit the default 320px pane width without truncating.
import { BotIcon, CloudIcon, HammerIcon } from 'lucide-react'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { useSettingsStore } from '@/state'
import { SampleDataRow } from './SampleDataRow'

interface SampleAgent {
  name: string
  status: string
}

const SAMPLE_AGENTS: SampleAgent[] = [
  { name: 'Triage agent', status: 'Deployed' },
  { name: 'Discharge drafter', status: 'Draft' }
]

export function AgentBuilderPanel() {
  const showSampleData = useSettingsStore((state) => state.settings.showSampleData)

  if (!showSampleData) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HammerIcon aria-hidden />
          </EmptyMedia>
          <EmptyTitle>Agent Builder isn't connected yet</EmptyTitle>
          <EmptyDescription>Waiting on the Agent Builder integration.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h3 className="mb-1 text-xs text-muted-foreground uppercase tracking-wide">Cloud agents</h3>
        <ul className="flex flex-col gap-1">
          {SAMPLE_AGENTS.map((agent) => (
            <SampleDataRow key={agent.name} icon={BotIcon} text={agent.name} meta={agent.status} />
          ))}
          <SampleDataRow icon={CloudIcon} text="3 templates available" />
        </ul>
      </div>
    </div>
  )
}
