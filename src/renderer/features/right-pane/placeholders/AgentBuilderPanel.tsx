// Agent Builder placeholder panel (spec 013 FR-018/FR-019, issue://393, PR2 of 4). Same shape as
// `FdbKnowledgePanel.tsx`, naming Agent Builder: honest empty state only -- no Settings
// dependency, no network call, no stored state. The "Show sample data" switch and its sample
// content (FR-020 to FR-022, spec 013 Slice 3's remaining tasks T017-T025) are PR3, not this PR.
import { HammerIcon } from 'lucide-react'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'

export function AgentBuilderPanel() {
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
