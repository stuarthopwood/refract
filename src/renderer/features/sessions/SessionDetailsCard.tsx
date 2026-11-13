import { cloneElement, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { CopyIcon, CpuIcon, FileDiffIcon, FolderIcon, GitBranchIcon, MapPinIcon } from 'lucide-react'
import { REVEAL_ACTION_LABEL, RevealActionIcon } from '@/components/revealAction'
import { useAnyMenuOpen } from '@/components/ui/exclusive-menu'
import { IconButton } from '@/components/IconButton'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { ReasoningGaugeIcon } from '@/components/ReasoningGaugeIcon'
import { useSessionsStore } from '@/state'
import { formatModelLabel, formatThinkingLevelLabel, MODEL_NOT_KNOWN } from '@/lib/modelDisplay'
import { friendlyProviderLabel } from '@/lib/providerLabels'
import type { DiffStat, SessionSummary } from '../../../shared/ipc'
import type { Repository } from '../../../shared/model'
import { DiffStatLine, StateIcon, displayLabel, displayStatus, formatAbsoluteTime, formatRelativeTime } from './sessionDisplay'
import { useWorktreeActions } from './useWorktreeActions'

/** Extracted out of `SessionRow` so that row (focus management, rename, menu) and card (hover-card lifecycle, diff stat, worktree actions) each stay a single concern. */
export function SessionDetailsCard({
  session,
  repository,
  worktreeMissing,
  activityDescription,
  activityText,
  children
}: {
  session: SessionSummary
  repository: Repository
  worktreeMissing: boolean
  // #567 decision 16: the row's own line-2 text, when it is not the branch (the start-progress or
  // "Terminated unexpectedly" text `SessionRow.tsx` shows instead) -- leads the accessible
  // description below so it is never silently dropped just because it does not fit on line 2.
  activityDescription?: string
  // #526: the full Activity line text while line 2 shows it; leads the card itself.
  activityText?: string | null
  children: ReactElement<{ 'aria-describedby'?: string }>
}) {
  // fetched fresh each time the details card opens, never cached across opens.
  const [diffStatResult, setDiffStatResult] = useState<DiffStat | null | 'loading'>('loading')
  // Each card-open issues a new `diffStat` request (up to 3 s); re-hovering or tabbing through rows
  // before the first one resolves must not let a stale response overwrite a newer one (or apply
  // after the card has closed), so only the most recently issued request's result is kept.
  const requestIdRef = useRef(0)
  const { copyPath, reveal } = useWorktreeActions(session)
  const descriptionId = `${session.id}-details`
  // The card never shows while any menu is open (#1404).
  const menuOpen = useAnyMenuOpen()
  const [cardOpen, setCardOpen] = useState(false)
  useEffect(() => {
    if (menuOpen) setCardOpen(false)
  }, [menuOpen])

  // Screen readers never reach this card's content: it is portaled to the end of `<body>` and
  // closes on blur before a virtual cursor could Tab into it, and `openDelay` means it is not yet
  // mounted when the trigger receives focus.
  const descriptionText = [
    activityDescription,
    `${session.branch} from ${session.baseBranch}`,
    `Last active ${formatAbsoluteTime(session.lastActivityAt)}`,
    `${session.worktreePath}${worktreeMissing ? ' (missing)' : ''}`
  ]
    .filter((part): part is string => Boolean(part))
    .join('. ')

  // fetches a fresh diff stat and re-lists Sessions (so a since-deleted worktree's `stopReason`
  // is current, not a stale cached value) every time the card opens.
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
      <HoverCard
        openDelay={750}
        open={cardOpen && !menuOpen}
        onOpenChange={(open) => {
          if (open && menuOpen) return
          setCardOpen(open)
          handleCardOpenChange(open)
        }}
      >
        <HoverCardTrigger asChild>
          {cloneElement(children, { 'aria-describedby': descriptionId })}
        </HoverCardTrigger>
        <HoverCardContent>
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <StateIcon status={displayStatus(session)} />
                <span>{displayLabel(session)}</span>
                <span className="text-xs text-muted-foreground">{formatRelativeTime(session.lastActivityAt)}</span>
              </div>
              {activityText && <p className="break-words pl-6 text-xs text-muted-foreground">{activityText}</p>}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <FolderIcon aria-hidden className="size-4 shrink-0" />
              <span className="truncate">{repository.name}</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <GitBranchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{session.branch}</span>
              <span className="shrink-0 text-muted-foreground">from {session.baseBranch}</span>
            </div>
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <MapPinIcon aria-hidden className="size-4 shrink-0" />
              <p className="min-w-0 flex-1 break-all">
                {worktreeMissing ? (
                  <>
                    {session.worktreePath} <span className="text-destructive">(missing)</span>
                  </>
                ) : (
                  session.worktreePath
                )}
              </p>
              <div className="-my-1 flex shrink-0 gap-1">
                <IconButton
                  label={worktreeMissing ? 'Worktree missing' : REVEAL_ACTION_LABEL}
                  size="icon-xs"
                  className="shrink-0 aria-disabled:opacity-50"
                  aria-disabled={worktreeMissing || undefined}
                  onClick={() => {
                    if (!worktreeMissing) void reveal()
                  }}
                >
                  <RevealActionIcon aria-hidden />
                </IconButton>
                <IconButton label="Copy path" size="icon-xs" className="shrink-0" onClick={() => void copyPath()}>
                  <CopyIcon aria-hidden />
                </IconButton>
              </div>
            </div>
            {/* Model and effort shown as two separately-iconed chips, never a bracketed "(Effort)" suffix (docs/DESIGN.md "No bracket/parenthetical UI copy"). */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="flex min-w-0 items-center gap-2 truncate">
                  <CpuIcon aria-hidden className="size-4 shrink-0" />
                  <span className="truncate">{formatModelLabel(session) ?? MODEL_NOT_KNOWN}</span>
                </span>
                {formatThinkingLevelLabel(session) && (
                  <span className="flex shrink-0 items-center gap-2">
                    <ReasoningGaugeIcon level={session.lastThinkingLevel} className="size-4 shrink-0" />
                    <span>
                      <span className="sr-only">Thinking level: </span>
                      {formatThinkingLevelLabel(session)}
                    </span>
                  </span>
                )}
              </div>
              {/* #741 Part 1/decision 4: a muted second line names the provider (friendly map, raw id fallback -- `friendlyProviderLabel`, `@/lib/providerLabels`), since this card has room for it that the composer strip does not. */}
              {session.lastModel && <p className="truncate pl-6 text-xs text-muted-foreground">via {friendlyProviderLabel(session.lastModel.provider)}</p>}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <FileDiffIcon aria-hidden className="size-4 shrink-0" />
              {/* Issue #925: both now render through the shared `DiffStatLine`, so the figure is coloured (and paired with its sr-only text) exactly the same way in both places. */}
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
          </div>
        </HoverCardContent>
      </HoverCard>
      <span id={descriptionId} className="sr-only">
        {descriptionText}
      </span>
    </>
  )
}
