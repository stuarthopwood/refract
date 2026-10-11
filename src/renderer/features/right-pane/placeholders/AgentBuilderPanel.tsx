// Agent Builder placeholder panel (spec 013 FR-018 to FR-022, issue://393). Same two-state shape
// as `FdbKnowledgePanel.tsx` (T027, research.md decision 6): off (default) renders the honest
// three-part empty state; on renders believable, clearly labelled sample cloud-agent content
// instead, each row carrying its own visible "Sample data" badge (FR-021, SC-006). Inert for the
// same reason `FdbKnowledgePanel.tsx` documents -- nothing real exists behind this panel yet.
import { BotIcon, CloudIcon, HammerIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { useSettingsStore } from '@/state'

interface SampleAgent {
  name: string
  status: string
}

const SAMPLE_AGENTS: SampleAgent[] = [
  { name: 'Readiness triage agent', status: 'Deployed' },
  { name: 'Discharge summary drafter', status: 'Draft' }
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
        <h3 className="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">Cloud agents</h3>
        <ul className="flex flex-col gap-1">
          {SAMPLE_AGENTS.map((agent) => (
            <li key={agent.name} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
              <BotIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{agent.status}</span>
              <Badge variant="secondary" className="shrink-0">
                Sample data
              </Badge>
            </li>
          ))}
          <li className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
            <CloudIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">3 cloud agent templates available</span>
            <Badge variant="secondary" className="shrink-0">
              Sample data
            </Badge>
          </li>
        </ul>
      </div>
    </div>
  )
}
