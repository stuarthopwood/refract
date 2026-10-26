import { cloneElement, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { CopyIcon, CpuIcon, FileDiffIcon, FolderIcon, FolderOpenIcon, GitBranchIcon, MapPinIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { ReasoningGaugeIcon } from '@/components/ReasoningGaugeIcon'
import { useSessionsStore } from '@/state'
import { formatModelLabel, formatThinkingLevelLabel } from '@/lib/modelDisplay'
import { friendlyProviderLabel } from '@/lib/providerLabels'
import type { DiffStat, SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { DiffStatLine, StateIcon, STATUS_LABEL, displayStatus, formatAbsoluteTime, formatRelativeTime } from './sessionDisplay'
import { useWorktreeActions } from './useWorktreeActions'

/** The session details card (T069/T070): wraps the row's open button (`children`, passed through
 * unchanged via `asChild` except for an added `aria-describedby`) in a shadcn `HoverCard`, owns
 * the diff-stat fetch for its own lifetime, and renders the Copy path / Open in file explorer
 * actions. Extracted out of `SessionRow` so that row (focus management, rename, menu) and card
 * (hover-card lifecycle, diff stat, worktree actions) each stay a single concern. */
export function SessionDetailsCard({
  session,
  repository,
  worktreeMissing,
  activityDescription,
  children
}: {
  session: SessionSummary
  repository: Repository
  worktreeMissing: boolean
  /** #567 decision 16: the row's own line-2 text, when it is not the branch (the start-progress
   *  or "Terminated unexpectedly" text `SessionRow.tsx` shows instead) -- leads the accessible
   *  description below so it is never silently dropped just because it does not fit on line 2. */
  activityDescription?: string
  children: ReactElement<{ 'aria-describedby'?: string }>
}) {
  // T069: fetched fresh each time the details card opens, never cached across opens.
  const [diffStatResult, setDiffStatResult] = useState<DiffStat | null | 'loading'>('loading')
  // Each card-open issues a new `diffStat` request (up to 3 s); re-hovering or tabbing through
  // rows before the first one resolves must not let a stale response overwrite a newer one (or
  // apply after the card has closed), so only the most recently issued request's result is kept.
  const requestIdRef = useRef(0)
  const { copyPath, reveal } = useWorktreeActions(session)
  const descriptionId = `${session.id}-details`

  // Screen readers never reach this card's content: it is portaled to the end of `<body>` and
  // closes on blur before a virtual cursor could Tab into it, and `openDelay` means it is not yet
  // mounted when the trigger receives focus. The base branch, worktree path, and missing state
  // are otherwise only ever shown inside the card, so they are duplicated here as a plain-text,
  // visually-hidden description linked to the trigger via `aria-describedby` (not pointed at the
  // card content itself, which may not exist yet at focus time).
  // #567 decision 16: "{activity text}. {branch} from {base}. Last active {long time}. {path}" --
  // replaces the shorter `From {base}. {path}` form, now that the row's own accessible name
  // (`SessionRow.tsx`'s `aria-label`) no longer carries the branch, base, or last-active time
  // itself; this description is the one place they still reach assistive technology.
  // Gate round 1 fix (Medium, a11y): "Last active" uses `formatAbsoluteTime`, not
  // `formatRelativeTime` -- see that function's own comment for why (description churn on a
  // focused row, once a minute, from the shared tick).
  const descriptionText = [
    activityDescription,
    `${session.branch} from ${session.baseBranch}`,
    `Last active ${formatAbsoluteTime(session.lastActivityAt)}`,
    `${session.worktreePath}${worktreeMissing ? ' (missing)' : ''}`
  ]
    .filter((part): part is string => Boolean(part))
    .join('. ')

  // T069: fetches a fresh diff stat and re-lists Sessions (so a since-deleted worktree's
  // `stopReason` is current, not a stale cached value) every time the card opens.
  function handleCardOpenChange(open: boolean): void {
    if (!open) return
    const requestId = ++requestIdRef.current
    setDiffStatResult('loading')
    void window.refract.sessions.diffStat(session.id).then((result) => {
      if (requestIdRef.current !== requestId) return // superseded by a later open
      setDiffStatResult(result.ok ? result.value : null)
    })
    void useSessionsStore.getState().refresh()
  }

  return (
    <>
      <HoverCard openDelay={750} onOpenChange={handleCardOpenChange}>
        <HoverCardTrigger asChild>
          {cloneElement(children, { 'aria-describedby': descriptionId })}
        </HoverCardTrigger>
        <HoverCardContent>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5">
              <StateIcon status={displayStatus(session)} />
              <span>{STATUS_LABEL[displayStatus(session)]}</span>
              <span className="text-xs text-muted-foreground">{formatRelativeTime(session.lastActivityAt)}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FolderIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{repository.name}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <GitBranchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{session.branch}</span>
              <span className="shrink-0 text-muted-foreground">from {session.baseBranch}</span>
            </div>
            <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <MapPinIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <p className="min-w-0 break-all">
                {worktreeMissing ? (
                  <>
                    {session.worktreePath} <span className="text-destructive">(missing)</span>
                  </>
                ) : (
                  session.worktreePath
                )}
              </p>
            </div>
            {/* Model and effort shown as two separately-iconed chips, never a bracketed "(Effort)"
                    suffix (docs/DESIGN.md "No bracket/parenthetical UI copy"). Gate round 1 fix
                    (LOW #12): the model/effort row and its own "via <Provider>" caption below are
                    grouped in one `flex flex-col gap-0.5` -- the outer card's own `gap-2` between
                    EVERY row read as "via Provider" belonging to the NEXT unrelated row, not a
                    caption of the model row directly above it. */}
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex min-w-0 items-center gap-1.5 truncate">
                  <CpuIcon aria-hidden className="size-3.5 shrink-0" />
                  <span className="truncate">{formatModelLabel(session) ?? 'Model not known yet'}</span>
                </span>
                {formatThinkingLevelLabel(session) && (
                  <span className="flex shrink-0 items-center gap-1.5">
                    <ReasoningGaugeIcon level={session.lastThinkingLevel} className="size-3.5 shrink-0" />
                    <span>
                      <span className="sr-only">Thinking level: </span>
                      {formatThinkingLevelLabel(session)}
                    </span>
                  </span>
                )}
              </div>
              {/* #741 Part 1/decision 4: a muted second line names the provider (friendly map,
                  raw id fallback -- `friendlyProviderLabel`, `@/lib/providerLabels`), since this
                  card has room for it that the composer strip does not. `pl-5` aligns it under
                  the model name's own text, past the CpuIcon (`size-3.5` + `gap-1.5` above it). */}
              {session.lastModel && <p className="truncate pl-5 text-xs text-muted-foreground">via {friendlyProviderLabel(session.lastModel.provider)}</p>}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileDiffIcon aria-hidden className="size-3.5 shrink-0" />
              {/* Gate round 5 fix (Flow LOW): this line had no `sr-only` full-figure pairing at
                  all, unlike the status line's identical `ChangesChip`, which carries one
                  (`formatDiffStatAccessible`, shared from `sessionDisplay.tsx` precisely so
                  this card and the status line can never phrase the same stat two ways). Issue
                  #925: both now render through the shared `DiffStatLine`, so the figure is
                  coloured (and paired with its sr-only text) exactly the same way in both
                  places. */}
              {worktreeMissing || diffStatResult === 'loading' || diffStatResult === null ? (
                <span className="truncate">
                  {worktreeMissing ? 'Not available' : diffStatResult === 'loading' ? 'Counting changes…' : 'Not available'}
                </span>
              ) : (
                <span className="truncate">
                  <DiffStatLine stat={diffStatResult} />
                </span>
              )}
            </div>
            <div className="flex items-center justify-end gap-1.5 pt-1">
              <Button variant="outline" size="xs" onClick={() => void copyPath()}>
                <CopyIcon aria-hidden />
                Copy path
              </Button>
              <Button variant="outline" size="xs" onClick={() => void reveal()}>
                <FolderOpenIcon aria-hidden />
                Open in file explorer
              </Button>
            </div>
          </div>
        </HoverCardContent>
      </HoverCard>
      <span id={descriptionId} className="sr-only">
        {descriptionText}
      </span>
    </>
  )
}
