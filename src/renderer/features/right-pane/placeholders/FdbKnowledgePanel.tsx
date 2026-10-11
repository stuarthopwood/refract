// FDB Knowledge placeholder panel (spec 013 FR-018/FR-019, issue://393, PR2 of 4). Honest empty
// state only -- no Settings dependency, no network call, no stored state. The "Show sample data"
// switch and its sample content (FR-020 to FR-022, spec 013 Slice 3's remaining tasks T017-T025)
// are PR3, not this PR: this component always renders the three-part empty state from
// `docs/design/patterns.md` ("Empty-state shape") regardless of any setting.
import { LibraryIcon } from 'lucide-react'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'

export function FdbKnowledgePanel() {
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
