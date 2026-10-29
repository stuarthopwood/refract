// The Report an issue dialog's duplicate check (issue #503, spec 049 decision 5): a collapsed
// "N possible duplicates" disclosure under Title. Hits are untrusted repository text, shown as
// plain text only. Advice, never a gate: filing is always possible.
import { useEffect, useState } from 'react'
import { CircleCheckIcon, CircleDotIcon, CircleSlashIcon, ExternalLinkIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineDisclosure } from '@/components/InlineDisclosure'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { safeUrl } from '@/lib/safe-url'
import type { IssueMatch } from '../../../shared/ipc-issues'

const STATE_DISPLAY = {
  OPEN: { Icon: CircleDotIcon, word: 'Open' },
  CLOSED: { Icon: CircleCheckIcon, word: 'Closed' }
} as const

export function IssueDuplicates({ matches }: { matches: IssueMatch[] }) {
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set())
  const shown = matches.filter((match) => !dismissed.has(match.number))
  useEffect(() => {
    if (shown.length === 0) setOpen(false)
  }, [shown.length])
  const label = `${shown.length} possible ${shown.length === 1 ? 'duplicate' : 'duplicates'}`
  return (
    <div>
      <span role="status" className="sr-only">
        {shown.length > 0 ? label : ''}
      </span>
      {shown.length > 0 && (
      <InlineDisclosure open={open} onOpenChange={setOpen} contentId="report-issue-duplicates" label={label}>
        <ul aria-label="Possible duplicate issues" className="flex flex-col gap-1">
          {shown.map((match) => {
            const { Icon, word } = STATE_DISPLAY[match.state] ?? { Icon: CircleSlashIcon, word: 'Closed' }
            const href = safeUrl(match.url)
            return (
              <li key={match.number} className="flex items-center gap-2 text-sm">
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="shrink-0 text-muted-foreground">#{match.number}</span>
                  <span className="min-w-0 truncate">{match.title}</span>
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <Icon aria-hidden className="size-3.5" />
                    {word}
                  </span>
                </span>
                {href && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button asChild variant="ghost" size="icon-xs">
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer noopener"
                          aria-label={`Open issue #${match.number} on GitHub`}
                        >
                          <ExternalLinkIcon aria-hidden />
                        </a>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{`Open issue #${match.number} on GitHub`}</TooltipContent>
                  </Tooltip>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setDismissed((previous) => new Set(previous).add(match.number))}
                >
                  It&apos;s different
                </Button>
              </li>
            )
          })}
        </ul>
      </InlineDisclosure>
      )}
    </div>
  )
}
