// The pull request detail view: header, description, Overview/Changes tabs, check-status chip (polled while pending),
// action row and comment composer. Action results show inline; disabled actions show their reason, and a
// not-mergeable pull request shows that reason instead of Merge.
import { useEffect, useId, useRef, useState } from 'react'
import { ConfirmAlertDialog } from '@/components/ConfirmAlertDialog'
import { InlineStatus } from '@/components/InlineStatus'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { OpenOnGitHubButton } from '@/components/OpenOnGitHubButton'
import { Markdown } from '@/features/chat/Markdown'
import { usePinnedPanelsStore } from '@/state'
import { createSessionFromItem, findExistingSession } from '@/features/sessions/startSessionFromItem'
import { requestSessionFromItem } from '@/features/sessions/startSessionRequest'
import { cn } from '@/lib/utils'
import type { PullRequestDetail as PullRequestDetailData } from '../../../shared/github'
import { CHECK_STATE_DISPLAY } from './PullRequestRow'
import { Timeline } from './Timeline'
import { CommentBox } from './CommentBox'
import { ChecksSection } from './ChecksSection'
import { resolvePullRequestImage } from './prImages'
import { ChangesTab } from './ChangesTab'
import { ReviewDialog } from './ReviewDialog'
import { MergeDialog } from './MergeDialog'
import { StatePill } from './StatePill'
import { StackSection } from './StackSection'
import { useStackFeatureOn, useStackPosition } from './useStack'
import { RefreshButton } from './RefreshButton'
import { ReviewConsensus } from './ReviewConsensus'

// Re-calls `detail()` every 15s while `checkState === 'pending'`; `list()` is never polled (4.8% of the rate-limit budget, docs/spike/FINDINGS.md).
const POLL_INTERVAL_MS = 15_000

interface PullRequestDetailProps {
  repositoryId: string
  number: number
  /** Wraps the header actions so the view fits a narrow right-pane panel. */
  compact?: boolean
}

export function PullRequestDetail({ repositoryId, number, compact = false }: PullRequestDetailProps) {
  const [detail, setDetail] = useState<PullRequestDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const reasonId = useId()
  const [forkWarningOpen, setForkWarningOpen] = useState(false)
  const [newSessionBusy, setNewSessionBusy] = useState(false)
  const [newSessionError, setNewSessionError] = useState<string | null>(null)
  // Unsent drafts live here, not in the tab content (which unmounts on an Overview/Changes switch);
  // they reset when the repository or pull request changes.
  const [commentDraft, setCommentDraft] = useState('')
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const reviewButtonRef = useRef<HTMLButtonElement>(null)
  const mergeButtonRef = useRef<HTMLButtonElement>(null)
  const newSessionButtonRef = useRef<HTMLButtonElement>(null)
  // Reassigned every render so a response for a previously selected pull request is recognised and dropped.
  const identityRef = useRef({ repositoryId, number })
  identityRef.current = { repositoryId, number }
  // Orders overlapping requests for the same pull request (poll, manual refresh, post-mutation reload) so a slower, older response cannot roll the view back.
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
    // Drop a response that is no longer the newest request for this pull request.
    if (loadSequenceRef.current !== sequence) return
    setLoading(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setDetail(result.value)
    usePinnedPanelsStore.getState().publishPullRequestState(repositoryId, number, result.value.state)
  }

  useEffect(() => {
    setDetail(null)
    setCommentDraft('')
    setReplyDrafts({})
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

  // Creates a Session on the pull request's head branch and switches to it, then sends or prefills the kickoff (#1310).
  async function handleNewSession(): Promise<void> {
    setNewSessionBusy(true)
    setNewSessionError(null)
    const message = await createSessionFromItem({ kind: 'pull-request', repositoryId, number })
    setNewSessionBusy(false)
    if (message) setNewSessionError(message)
  }

  function handleNewSessionClick(): void {
    const ref = { kind: 'pull-request' as const, repositoryId, number }
    if (findExistingSession(ref)) {
      void requestSessionFromItem(ref)
      return
    }
    // A fork pull request's head branch runs its author's code and AGENTS.md/prompt content, so warn first.
    if (detail?.isFork) {
      setForkWarningOpen(true)
      return
    }
    void handleNewSession()
  }

  // Only an open or draft pull request can sit in a live stack; merged and closed ones read no refs.
  const stackState = detail?.state === 'open' || detail?.state === 'draft' ? detail.state : null
  const stack = useStackPosition(repositoryId, number, stackState)
  const stackFeatureOn = useStackFeatureOn()
  if (loading && !detail) {
    return <InlineStatus tone="loading">Loading…</InlineStatus>
  }
  if (error && !detail) {
    return (
      <div className="flex flex-col items-start gap-2">
        <InlineStatus tone="error">{error}</InlineStatus>
        <RefreshButton loading={loading} onClick={() => void load()} label="Retry loading this pull request" />
      </div>
    )
  }
  if (!detail) return null

  const title = `pull request #${detail.number}`
  const check = CHECK_STATE_DISPLAY[detail.checkState]
  const CheckIcon = check.icon
  // `mergeableState === 'unknown'` (GitHub still computing) gets its own "still checking" text and only
  // disables Merge when nothing else explains why.
  const mergeStillChecking = detail.mergeDisabledReason === null && detail.mergeableState === 'unknown'
  const mergeBlocked = detail.mergeDisabledReason !== null || detail.mergeableState !== 'mergeable'
  // A disabled button is not focusable, so a blocked Merge always needs visible text.
  const mergeDisabledReason =
    detail.mergeDisabledReason ??
    (mergeStillChecking ? 'GitHub is still checking whether this pull request can merge.' : mergeBlocked ? 'This pull request cannot be merged right now.' : null)
  // Merged and closed pull requests hide their actions; the StatePill says why (#1393). Draft keeps them.
  const actionsHidden = detail.state === 'merged' || detail.state === 'closed'
  // A state-only disable already shows its reason via the StatePill; these lines show only while the
  // pull request is open (or draft) but a button is disabled (#1131).
  const showReviewReasonLine = detail.reviewDisabledReason !== null && !actionsHidden
  const showMergeReasonLine = mergeDisabledReason !== null && mergeDisabledReason !== detail.reviewDisabledReason && !actionsHidden
  // A deduped Merge reason is explained by the Review line.
  const mergeReasonLinkId = showMergeReasonLine ? `${reasonId}-merge` : mergeBlocked && showReviewReasonLine ? `${reasonId}-review` : undefined

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* drag-regions-allow: renders right of PullRequestList, below PullRequestsView's own h-10 drag-region header, so it never touches App.tsx's strip despite the same shape. */}
      <div className="shrink-0 p-4">
        <div className={cn('flex justify-between gap-2', compact ? 'flex-col' : 'flex-wrap items-start')}>
          <div className="min-w-[200px] flex-1">
            <h2 ref={headingRef} tabIndex={-1} className="line-clamp-2 text-lg font-semibold outline-none">
              {detail.title} <span className="font-normal text-muted-foreground">#{detail.number}</span>
            </h2>
            <p className="text-xs text-muted-foreground">
              <span className="font-code">{detail.headBranch}</span> into <span className="font-code">{detail.baseBranch}</span> by{' '}
              {detail.author.name ?? detail.author.login}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <StatePill state={detail.state} />
              {/* Check status carries its own severity colour (`CHECK_STATE_DISPLAY.colorClass`, shared with `PullRequestRow.tsx`) (#1121). */}
              <span className={cn('flex items-center gap-1 text-xs', check.colorClass)}>
                <CheckIcon aria-hidden className={cn('size-4', detail.checkState === 'pending' && 'animate-spin')} />
                {check.label}
              </span>
            </div>
            {stack && stackFeatureOn && <StackSection repositoryId={repositoryId} number={number} position={stack} />}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <RefreshButton loading={loading} onClick={() => void load()} label="Refresh this pull request" />
            <OpenOnGitHubButton url={detail.url} />
            <CopyButton getText={() => detail.url} label="Copy link" announcement="Pull request link copied" />
            {!actionsHidden && (
              <>
                <Button
                  ref={newSessionButtonRef}
                  size="sm"
                  variant="ghost"
                  onClick={handleNewSessionClick}
                  disabled={newSessionBusy || detail.state !== 'open'}
                >
                  {newSessionBusy ? 'Starting…' : 'New session'}
                </Button>
                <Button
                  ref={reviewButtonRef}
                  size="sm"
                  variant="ghost"
                  className="aria-disabled:opacity-50"
                  onClick={() => detail.reviewDisabledReason === null && setReviewOpen(true)}
                  aria-disabled={detail.reviewDisabledReason !== null || undefined}
                  aria-describedby={showReviewReasonLine ? `${reasonId}-review` : undefined}
                  title={detail.reviewDisabledReason ?? undefined}
                >
                  Review
                </Button>
                <Button
                  ref={mergeButtonRef}
                  size="sm"
                  variant="default"
                  className="aria-disabled:opacity-50"
                  onClick={() => !mergeBlocked && setMergeOpen(true)}
                  aria-disabled={mergeBlocked || undefined}
                  aria-describedby={mergeReasonLinkId}
                  title={mergeDisabledReason ?? undefined}
                >
                  Merge
                </Button>
              </>
            )}
          </div>
        </div>
        {detail.state === 'draft' && !actionsHidden && (
          <p data-draft-reason className="mt-1 text-xs text-muted-foreground">
            Draft pull requests cannot start a Session.
          </p>
        )}
        {showReviewReasonLine && (
          <p id={`${reasonId}-review`} data-review-reason className="mt-1 text-xs text-muted-foreground">
            Review: {detail.reviewDisabledReason}
          </p>
        )}
        {showMergeReasonLine && (
          <p id={`${reasonId}-merge`} data-merge-reason className="mt-1 text-xs text-muted-foreground">
            Merge: {mergeDisabledReason}
          </p>
        )}
        {newSessionError && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {newSessionError}
          </p>
        )}
        {error && detail && (
          // The refresh button covers recovery, but the failure itself still needs showing.
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
          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {detail.reviewers.length > 0 && <span>Reviewers: {detail.reviewers.map((r) => r.name ?? r.login).join(', ')}</span>}
            {detail.assignees.length > 0 && <span>Assignees: {detail.assignees.map((a) => a.name ?? a.login).join(', ')}</span>}
          </div>
        )}
      </div>
      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <TabsList className="mx-2 mt-2 h-auto shrink-0 gap-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="changes">
            Changes ({detail.changedFilesCount} file{detail.changedFilesCount === 1 ? '' : 's'})
          </TabsTrigger>
        </TabsList>
        {/* #1200: `relative` keeps the comment box's `sr-only` alert (absolute) inside this scroller. */}
        <TabsContent value="overview" className="relative min-h-0 flex-1 overflow-auto">
          <div className="p-4">
            <ReviewConsensus timeline={detail.timeline} authorLogin={detail.author.login} />
            <Markdown id={`pr-${detail.number}-description`} text={detail.description || '_No description._'} githubStyle resolveImage={resolvePullRequestImage} />
          </div>
          <Timeline repositoryId={repositoryId} number={number} entries={detail.timeline} viewerLogin={detail.viewerLogin} replyDrafts={replyDrafts} onReplyDraftChange={(threadId, value) => setReplyDrafts((prev) => ({ ...prev, [threadId]: value }))} onChanged={() => void load()} />
          <ChecksSection checks={detail.checks} checkState={detail.checkState} />
          <CommentBox
            repositoryId={repositoryId}
            number={number}
            state={detail.state}
            title={title}
            prTitle={detail.title}
            text={commentDraft}
            onTextChange={setCommentDraft}
            headingRef={headingRef}
            onChanged={() => void load()}
          />
        </TabsContent>
        <TabsContent value="changes" className="relative min-h-0 flex-1 overflow-auto">
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
        headBranch={detail.headBranch}
        stack={stack}
        allowedMergeMethods={detail.allowedMergeMethods}
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        onMerged={() => void load()}
        restoreFocusTo={mergeButtonRef}
        restoreFocusFallbackTo={headingRef}
      />
      <ConfirmAlertDialog
        open={forkWarningOpen}
        busy={false}
        size="md"
        title="Start a Session on untrusted code?"
        description={
          <>
            <span className="block">
              {title} comes from a fork{detail.headRepositoryOwner ? ` owned by ${detail.headRepositoryOwner}` : ''}, not this project's GitHub repository.
            </span>
            <span className="mt-2 block">
              Its branch may contain code, commit messages, or an AGENTS.md written by someone you don't control, which an agent session would then read and could act on.
            </span>
            <span className="mt-2 block">Only continue if you trust this pull request's author.</span>
          </>
        }
        confirmLabel="Start Session anyway"
        onCancel={() => setForkWarningOpen(false)}
        onConfirm={() => {
          setForkWarningOpen(false)
          void handleNewSession()
        }}
        onCloseAutoFocus={() => {
          // Restore focus to the "New session" button (or the detail heading if it is now disabled), like `MergeDialog`.
          const button = newSessionButtonRef.current
          if (button && !button.disabled) button.focus()
          else headingRef.current?.focus()
        }}
      />
    </div>
  )
}
