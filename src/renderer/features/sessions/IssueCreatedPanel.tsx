// The Report an issue dialog's result panel (issue #503, spec 049 decision 7): replaces the form
// once `gh issue create` succeeds. The heading takes focus so a screen reader hears the result.
import { useEffect, useRef } from 'react'
import { ExternalLinkIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { DialogFooter } from '@/components/ui/dialog'
import { safeUrl } from '@/lib/safe-url'
import type { CreatedIssue } from '../../../shared/ipc-issues'

interface IssueCreatedPanelProps {
  issue: CreatedIssue
  onClose: () => void
  onReportAnother: () => void
}

export function IssueCreatedPanel({ issue, onClose, onReportAnother }: IssueCreatedPanelProps) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => headingRef.current?.focus(), [])
  const href = safeUrl(issue.url)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h3 ref={headingRef} tabIndex={-1} className="text-sm font-medium outline-none">
          Issue #{issue.number} created
        </h3>
        <CopyButton getText={() => issue.url} label="Copy link" announcement="Issue link copied" />
      </div>
      <DialogFooter>
        <Button type="button" variant="text" onClick={onReportAnother}>
          Report another
        </Button>
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
        {href && (
          <Button asChild>
            <a href={href} target="_blank" rel="noreferrer noopener">
              <ExternalLinkIcon aria-hidden />
              Open on GitHub
            </a>
          </Button>
        )}
      </DialogFooter>
    </div>
  )
}
