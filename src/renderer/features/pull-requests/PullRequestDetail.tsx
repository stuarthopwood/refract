// The pull request detail view (specs/003-pull-request-management FR-007 to FR-011, FR-012,
// FR-015 to FR-022, T015, T019, T022, T026): header (title, number, state, branches, reviewers,
// assignees, labels -- FR-007), the description through `Markdown.tsx`, an Overview/Changes
// `Tabs` pair, the check-status header chip (FR-010, polled per research.md "Polling interval"
// while a check is pending -- FR-010, FR-028), the header action row (New session, Review,
// merge/checks status), and a top-level comment composer (FR-012). Every action result (success
// or the exact failure, including `stale`) is shown inline (FR-018); draft/closed/merged pull
// requests show `reviewDisabledReason`/`mergeDisabledReason` next to each disabled action
// (FR-019), and a not-mergeable pull request shows that reason instead of offering Merge (FR-020).
import { useEffect, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Markdown } from '@/features/chat/Markdown'
import { useSessionsStore, useSplitStore, useViewStore } from '@/state'
import { cn } from '@/lib/utils'
import type { PullRequestDetail as PullRequestDetailData } from '../../../shared/github'
import { CHECK_STATE_DISPLAY } from './PullRequestRow'
import { Timeline } from './Timeline'
import { ChangesTab } from './ChangesTab'
import { ReviewDialog } from './ReviewDialog'
import { MergeDialog } from './MergeDialog'
import { StatePill } from './StatePill'
import { RefreshButton } from './RefreshButton'
import { ReviewConsensus } from './ReviewConsensus'

// research.md "Polling interval and rate-limit headroom": re-calls `detail()` every 15s while
// `checkState === 'pending'`, stops once checks finish or this view closes; `list()` is never
// polled (FR-006, FR-028). Confirmed a small fraction (4.8%) of the account's rate-limit budget
// (docs/spike/FINDINGS.md row 40).
const POLL_INTERVAL_MS = 15_000

interface PullRequestDetailProps {
  repositoryId: string
  number: number
}

export function PullRequestDetail({ repositoryId, number }: PullRequestDetailProps) {
  const [detail, setDetail] = useState<PullRequestDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [forkWarningOpen, setForkWarningOpen] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)
  const [newSessionBusy, setNewSessionBusy] = useState(false)
  const [newSessionError, setNewSessionError] = useState<string | null>(null)
  const openChat = useViewStore((s) => s.openChat)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const reviewButtonRef = useRef<HTMLButtonElement>(null)
  const mergeButtonRef = useRef<HTMLButtonElement>(null)
  const newSessionButtonRef = useRef<HTMLButtonElement>(null)
  // High remediation (code-reviewer): `load()`'s own closure-captured `repositoryId`/`number`
  // can't detect that the user has since selected a DIFFERENT pull request by the time its
  // `await` resolves -- selecting A then quickly B could let A's slower response overwrite B's
  // already-rendered data. This ref is reassigned every render (`DeleteDialog.tsx`'s own
  // `sessionIdRef` pattern), so a stale response is recognised and dropped instead of applied.
  const identityRef = useRef({ repositoryId, number })
  identityRef.current = { repositoryId, number }
  // Medium remediation (round 3, code-reviewer): `identityRef` alone only tells apart responses
  // for a DIFFERENT pull request -- it says nothing about which of several overlapping requests
  // FOR THE SAME pull request is newest. The 15s poll, the manual refresh button, and a
  // post-mutation reload (`onMerged`/`onSubmitted` below) can all be in flight at once; without
  // this, a slower poll response landing after a faster manual refresh could silently roll the
  // view back to stale data. Matches `pull-requests-store.ts`'s own `refreshSequence` pattern,
  // scoped per-component instead of per-repository since this component already owns one PR.
  const loadSequenceRef = useRef(0)
  async function load(): Promise<void> {
    const requestedFor = { repositoryId, number }
    loadSequenceRef.current += 1
    const sequence = loadSequenceRef.current
    setLoading(true)
    setError(null)
    const result = await window.refract.pullRequests.detail(repositoryId, number)
    if (identityRef.current.repositoryId !== requestedFor.repositoryId || identityRef.current.number !== requestedFor.number) {
      return
    }
    // See `loadSequenceRef`'s own doc comment above: a response that is no longer the newest
    // in-flight request for this exact pull request is dropped, even though it's for the right
    // one -- an older, slower poll tick can resolve after a newer manual refresh or post-mutation
    // reload already landed.
    if (loadSequenceRef.current !== sequence) return
    setLoading(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setDetail(result.value)
  }

  useEffect(() => {
    setDetail(null)
    void load()
    // Only the identity of the pull request being viewed should re-trigger the initial load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositoryId, number])

  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    if (detail?.checkState === 'pending') {
      pollRef.current = setInterval(() => void load(), POLL_INTERVAL_MS)
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.checkState, repositoryId, number])

  async function handleComment(): Promise<void> {
    const body = commentText.trim()
    if (!body) return
    setCommentBusy(true)
    setCommentError(null)
    const result = await window.refract.pullRequests.comment(repositoryId, number, body)
    setCommentBusy(false)
    if (!result.ok) {
      setCommentError(result.error.message)
      return
    }
    setCommentText('')
    void load()
  }

  // FR-022: creates a Session on the pull request's head branch, then switches to it exactly as
  // the existing "created and opened" convention does (sessions-store.ts's own `create()`).
  async function handleNewSession(): Promise<void> {
    setNewSessionBusy(true)
    setNewSessionError(null)
    const result = await window.refract.pullRequests.newSessionFromPullRequest(repositoryId, number)
    setNewSessionBusy(false)
    if (!result.ok) {
      setNewSessionError(result.error.message)
      return
    }
    await useSessionsStore.getState().refresh()
    useSplitStore.getState().replaceFocused(result.value.id)
    openChat()
  }

  function handleNewSessionClick(): void {
    // Security remediation (Medium-but-must-fix): a fork pull request's head branch runs
    // whatever code (and AGENTS.md/prompt content) its author wrote -- starting a Session on it
    // used to happen with no warning at all.
    if (detail?.isFork) {
      setForkWarningOpen(true)
      return
    }
    void handleNewSession()
  }

  if (loading && !detail) {
    return <div className="p-4 text-sm text-muted-foreground">Loading…</div>
  }
  if (error && !detail) {
    return (
      <div role="alert" className="p-4 text-sm text-destructive">
        {error}
      </div>
    )
  }
  if (!detail) return null

  const title = `pull request #${detail.number}`
  const check = CHECK_STATE_DISPLAY[detail.checkState]
  const CheckIcon = check.icon
  // "Also fix" remediation: `mergeableState === 'unknown'` (GitHub still computing mergeability)
  // used to collapse into the same "not mergeable" message as a real conflict; it gets its own
  // "still checking" text instead, and only disables Merge when nothing else already explains why.
  const mergeStillChecking = detail.mergeDisabledReason === null && detail.mergeableState === 'unknown'
  const mergeDisabledReason = detail.mergeDisabledReason ?? (mergeStillChecking ? 'GitHub is still checking whether this pull request can merge.' : null)
  const mergeBlocked = detail.mergeDisabledReason !== null || detail.mergeableState !== 'mergeable'

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* drag-regions-allow: renders right of PullRequestList, below PullRequestsView's own h-10 drag-region header, so it never touches App.tsx's strip despite the same shape. */}
      <div className="shrink-0 border-b border-border p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 ref={headingRef} tabIndex={-1} className="line-clamp-2 text-lg font-semibold outline-none">
              {detail.title} <span className="font-normal text-muted-foreground">#{detail.number}</span>
            </h2>
            <p className="text-xs text-muted-foreground">
              {detail.headBranch} into {detail.baseBranch} by {detail.author.name ?? detail.author.login}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {/* High remediation (accessibility-auditor, FR-007/FR-030): open/draft/closed/merged
                was never visibly conveyed in the detail header at all. Issue #568 decision 5:
                solid StatePill (not the outline Badge this used to be). */}
            <StatePill state={detail.state} />
            {/* Issue #568 decision 5: check status stays a plain icon+word (no pill chrome),
                turning red only on failure -- reusing #570's "colour signals failure only"
                policy, same treatment `PullRequestRow.tsx`'s own metadata line just adopted. */}
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <CheckIcon
                aria-hidden
                className={cn(
                  'size-3.5',
                  detail.checkState === 'pending' && 'animate-spin',
                  detail.checkState === 'failed' && 'text-severity-error'
                )}
              />
              {check.label}
            </span>
            <RefreshButton loading={loading} onClick={() => void load()} label="Refresh this pull request" />
            <Button
              ref={newSessionButtonRef}
              size="sm"
              variant="ghost"
              onClick={handleNewSessionClick}
              disabled={newSessionBusy || detail.state !== 'open'}
              title={detail.state !== 'open' ? 'Only an open pull request can start a Session.' : undefined}
            >
              {newSessionBusy ? 'Starting…' : 'New session'}
            </Button>
            <Button
              ref={reviewButtonRef}
              size="sm"
              variant="ghost"
              onClick={() => setReviewOpen(true)}
              disabled={detail.reviewDisabledReason !== null}
              title={detail.reviewDisabledReason ?? undefined}
            >
              Review
            </Button>
            <Button
              ref={mergeButtonRef}
              size="sm"
              onClick={() => setMergeOpen(true)}
              disabled={mergeBlocked}
              title={mergeDisabledReason ?? undefined}
            >
              Merge
            </Button>
          </div>
        </div>
        {mergeDisabledReason && <p className="mt-1 text-xs text-muted-foreground">{mergeDisabledReason}</p>}
        {newSessionError && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {newSessionError}
          </p>
        )}
        {error && detail && (
          // "Also fix" remediation: a `stale` (or any other) detail-level failure used to have no
          // recovery short of navigating away and back -- the refresh button above now covers
          // this, but the failure itself still needs to be shown.
          <p role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        )}
        {detail.labels.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {detail.labels.map((label) => (
              <Badge key={label} variant="secondary">
                {label}
              </Badge>
            ))}
          </div>
        )}
        {(detail.reviewers.length > 0 || detail.assignees.length > 0) && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {detail.reviewers.length > 0 && <span>Reviewers: {detail.reviewers.map((r) => r.name ?? r.login).join(', ')}</span>}
            {detail.assignees.length > 0 && <span>Assignees: {detail.assignees.map((a) => a.name ?? a.login).join(', ')}</span>}
          </div>
        )}
      </div>
      {/* Issue #568 decision 3: underline tabs as a call-site-local override only -- the
          shared `tabs.tsx` primitive and its default pill classes stay untouched, since the
          same primitive also renders the five filter tabs in `PullRequestList.tsx` (deferred
          to #499). Focus-visible classes are left completely alone; only box/border/colour
          utilities are overridden here. */}
      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* drag-regions-allow: the underline tab strip's own `border-b` (needed for the visual
            underline look, decision 3) happens to match this script's window-chrome-header
            heuristic (`border-b` + `shrink-0`), but this row sits deep in the content area, well
            below `PullRequestsView.tsx`'s own separate `h-10` drag-region strip -- it never
            touches `App.tsx`'s drag strip despite the coincidental shape; drag-regions-allow: see above. */}
        <TabsList className="mx-3 mt-2 h-auto w-fit shrink-0 gap-4 rounded-none border-b border-border bg-transparent p-0">
          <TabsTrigger
            value="overview"
            className="rounded-none border-b-2 border-transparent px-1 py-1.5 text-muted-foreground shadow-none data-[state=active]:border-accent-text data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none hover:border-border hover:text-foreground"
          >
            Overview
          </TabsTrigger>
          <TabsTrigger
            value="changes"
            className="rounded-none border-b-2 border-transparent px-1 py-1.5 text-muted-foreground shadow-none data-[state=active]:border-accent-text data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none hover:border-border hover:text-foreground"
          >
            Changes ({detail.changedFilesCount} file{detail.changedFilesCount === 1 ? '' : 's'})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="min-h-0 flex-1 overflow-auto">
          <div className="p-3">
            <ReviewConsensus timeline={detail.timeline} />
            <Markdown id={`pr-${detail.number}-description`} text={detail.description || '_No description._'} />
          </div>
          <Timeline repositoryId={repositoryId} number={number} entries={detail.timeline} onChanged={() => void load()} />
          <div className="border-t border-border p-3">
            <Textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="Add a comment"
              aria-label="Add a comment to this pull request"
              className="min-h-20"
              disabled={commentBusy}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <p role="alert" className={cn('text-xs text-destructive', !commentError && 'sr-only')}>
                {commentError ?? ''}
              </p>
              <Button size="sm" onClick={() => void handleComment()} disabled={commentBusy || !commentText.trim()}>
                {commentBusy ? 'Commenting…' : 'Comment'}
              </Button>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="changes" className="min-h-0 flex-1 overflow-auto">
          <ChangesTab
            additions={detail.additions}
            deletions={detail.deletions}
            changedFilesCount={detail.changedFilesCount}
            files={detail.files}
            url={detail.url}
          />
        </TabsContent>
      </Tabs>
      <ReviewDialog
        repositoryId={repositoryId}
        number={number}
        title={title}
        headSha={detail.headSha}
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        onSubmitted={() => void load()}
        restoreFocusTo={reviewButtonRef}
        restoreFocusFallbackTo={headingRef}
      />
      <MergeDialog
        repositoryId={repositoryId}
        number={number}
        title={title}
        headSha={detail.headSha}
        allowedMergeMethods={detail.allowedMergeMethods}
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        onMerged={() => void load()}
        restoreFocusTo={mergeButtonRef}
        restoreFocusFallbackTo={headingRef}
      />
      <AlertDialog open={forkWarningOpen} onOpenChange={setForkWarningOpen}>
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // Medium remediation (round 3, a11y: new regression introduced alongside this
            // round's security fix): this dialog only called `preventDefault()` with no actual
            // focus target, unlike `MergeDialog`/`ReviewDialog`'s identical sibling dialogs
            // (correctly fixed this same round) -- dropping focus to `<body>` on every close,
            // Cancel or "Start Session anyway" alike. Restores to the "New session" button that
            // opened it, falling back to the detail heading if that button is now disabled
            // (e.g. the pull request closed while this was open), matching `MergeDialog`'s
            // exact pattern.
            event.preventDefault()
            const button = newSessionButtonRef.current
            if (button && !button.disabled) button.focus()
            else headingRef.current?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Start a Session on untrusted code?</AlertDialogTitle>
            <AlertDialogDescription>
              {title} comes from a fork{detail.headRepositoryOwner ? ` owned by ${detail.headRepositoryOwner}` : ''}, not this repository.
              Its branch may contain code, commit messages, or an AGENTS.md written by someone you don't control, which an agent session
              would then read and could act on. Only continue if you trust this pull request's author.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                setForkWarningOpen(false)
                void handleNewSession()
              }}
            >
              Start Session anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
