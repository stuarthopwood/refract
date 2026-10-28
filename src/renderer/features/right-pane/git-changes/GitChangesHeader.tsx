// Spec 018 slice 1 (issue #464), User Story 3: the panel's own branch-line row (FR-014), reusing
// `SessionDetailsCard.tsx`'s branch-line shape (`GitBranchIcon` + branch + muted "from {base}")
// verbatim, plus a net-new muted ahead/behind figure appended to the same row -- entirely
// omitted when `aheadBehind` is `null` (no upstream), never shown as a misleading "0 ahead, 0
// behind" (FR-014, User Story 3 acceptance scenario 2).
import { ArrowDownIcon, ArrowUpIcon, GitBranchIcon } from 'lucide-react'
import type { GitChangesHeader as GitChangesHeaderData } from '../../../../shared/model'

export function GitChangesHeader({ header }: { header: GitChangesHeaderData }) {
  return (
    <div className="no-drag-region flex shrink-0 items-center gap-2 border-b border-divider px-2 py-1 text-xs">
      <GitBranchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate" title={header.branch}>
        {header.branch}
      </span>
      <span className="shrink-0 text-muted-foreground">from {header.baseBranch}</span>
      {header.aheadBehind && (
        <span className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
          <span aria-hidden className="flex items-center gap-1">
            <ArrowUpIcon className="size-4" />
            <span className="tabular-nums">{header.aheadBehind.ahead}</span>
            <ArrowDownIcon className="size-4" />
            <span className="tabular-nums">{header.aheadBehind.behind}</span>
          </span>
          <span className="sr-only">
            {header.aheadBehind.ahead} ahead, {header.aheadBehind.behind} behind
          </span>
        </span>
      )}
    </div>
  )
}
