// Spec 018 slice 1 (issue #464), User Story 2: the panel's fixed, non-scrolling commit-box
// footer (FR-009 to FR-013, FR-023, FR-024) -- a subject field with a live character counter, a
// body field, and a Commit button, disabled with exactly one visible reason whenever the Git
// status itself is unavailable, a conflict is unresolved, nothing is staged, or the message is
// empty (`aria-disabled` + `title` + a visible reason line, the same disabled-with-reason
// convention `PullRequestDetail.tsx`'s own Merge button already uses -- never the native
// `disabled` attribute, which would drop focus to `<body>` the moment the last staged file is
// unstaged out from under a focused Commit button).
// Ctrl/Cmd+Enter from anywhere in either field commits (matching the composer's own send
// shortcut), skipped while an IME composition is in progress so a composing Enter never fires a
// commit early. A quiet inline warning shows whenever the focused Session's status is `working`,
// without disabling Commit on that basis alone (FR-012); any stage/unstage/commit failure (the
// store's own `actionError`, 2026-10-20 gate fix: split from the unrelated `loadError`, so a
// background refresh can never silently clear an unacknowledged action failure) surfaces here as
// a plain inline `role="alert"` (FR-013), the one place this panel announces an alert so a load
// failure and an action failure are never double-announced in two places at once.
//
// Gate round 2 fixes (2026-10-20):
// - Item 4: dismissing an action error refocuses the subject field (same landing spot a
//   successful commit already uses) and the dismiss control is labelled "Dismiss error" (not a
//   bare, context-free "Dismiss").
// - Item 6: `GitChangesPanel.tsx` now keeps this component mounted once a snapshot has ever
//   loaded for this Session, even if a LATER load reverts it to `null` (the worktree became
//   genuinely unavailable mid-Session) -- `!entry?.snapshot` is therefore its own top-priority
//   disabled reason ("Git status unavailable"), ahead of conflicts/staged/message, since without
//   a snapshot this component cannot know whether any of those are even true. The subject/body
//   draft itself moved from local `useState` into the store's own per-Session `commitDraft` (set
//   via `setCommitDraft`), so it survives this remount-avoidance AND a Session switch away and
//   back (which still remounts `GitChangesPanel` itself).
import { useId, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { TriangleAlertIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useGitChangesStore, useSessionsStore } from '@/state'

export function GitCommitBox({ sessionId }: { sessionId: string }) {
  const entry = useGitChangesStore((s) => s.bySession[sessionId])
  const sessionStatus = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status)
  const subject = entry?.commitDraft.subject ?? ''
  const body = entry?.commitDraft.body ?? ''
  const [committing, setCommitting] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const subjectId = useId()
  const bodyId = useId()
  const warningId = useId()
  const reasonId = useId()

  function updateDraft(partial: Partial<{ subject: string; body: string }>): void {
    useGitChangesStore.getState().setCommitDraft(sessionId, { subject, body, ...partial })
  }

  const conflictCount = entry?.snapshot?.groups.conflicts.length ?? 0
  const stagedCount = entry?.snapshot?.groups.staged.length ?? 0
  const trimmedSubject = subject.trim()
  const trimmedBody = body.trim()
  // FR-009: subject + blank line + body, the conventional git shape -- FR-024 still holds (no
  // format is ENFORCED; a bare body with no subject, or vice versa, is composed as-is below).
  const message = trimmedSubject && trimmedBody ? `${trimmedSubject}\n\n${trimmedBody}` : trimmedSubject || trimmedBody
  // Gate round 1 item 11: a conflict blocks Commit outright, checked BEFORE "Nothing staged"/
  // "Write a message" -- git itself refuses to commit any staged changes while a conflict
  // remains anywhere in the worktree, regardless of what else is staged or typed. Gate round 2
  // item 6: a missing snapshot outranks even that -- without one this component cannot know
  // whether there IS a conflict, so it must not claim any of the more specific reasons below.
  const disabledReason = !entry?.snapshot
    ? 'Git status unavailable'
    : conflictCount > 0
      ? 'Resolve conflicts first'
      : stagedCount === 0
        ? 'Nothing staged'
        : message.length === 0
          ? 'Write a message'
          : null

  async function handleCommit(): Promise<void> {
    if (disabledReason || committing) return
    const committedSubject = trimmedSubject || trimmedBody
    setCommitting(true)
    await useGitChangesStore.getState().commit(sessionId, message)
    setCommitting(false)
    // `runAction` (git-changes-store.ts) clears `actionError` up front and only sets it again on
    // a genuine failure -- reading it fresh here, rather than trusting a local "it resolved"
    // flag, is how a real failure is told apart from success without the store returning a
    // redundant boolean of its own.
    if (useGitChangesStore.getState().bySession[sessionId]?.actionError === null) {
      useGitChangesStore.getState().setCommitDraft(sessionId, { subject: '', body: '' })
      setAnnouncement(`Committed: ${committedSubject}`)
      document.getElementById(subjectId)?.focus()
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void handleCommit()
    }
  }

  const describedBy = [sessionStatus === 'working' ? warningId : null, disabledReason ? reasonId : null].filter(Boolean).join(' ') || undefined

  return (
    <div className="no-drag-region flex shrink-0 flex-col gap-1.5 border-t border-divider p-2">
      {sessionStatus === 'working' && (
        <p id={warningId} role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
          Agent is working — review before committing
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <label htmlFor={subjectId} className="sr-only">
          Commit subject
        </label>
        <Input
          id={subjectId}
          value={subject}
          onChange={(event) => updateDraft({ subject: event.target.value })}
          onKeyDown={handleKeyDown}
          placeholder="Commit subject"
          className="flex-1"
        />
        <span aria-hidden className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {subject.length}
        </span>
      </div>
      <label htmlFor={bodyId} className="sr-only">
        Commit description
      </label>
      <Textarea
        id={bodyId}
        value={body}
        onChange={(event) => updateDraft({ body: event.target.value })}
        onKeyDown={handleKeyDown}
        placeholder="Description (optional)"
        className="max-h-32 min-h-12 overflow-y-auto text-sm"
      />
      {entry?.actionError && (
        <div className="flex items-start gap-1.5">
          <p role="alert" className="max-h-24 flex-1 overflow-y-auto whitespace-pre-wrap text-xs text-destructive">
            {entry.actionError}
          </p>
          <button
            type="button"
            className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => {
              useGitChangesStore.getState().dismissActionError(sessionId)
              document.getElementById(subjectId)?.focus()
            }}
          >
            Dismiss error
          </button>
        </div>
      )}
      {/* Item 8: a commit success is announced once, same `role="status"` pattern as the
          agent-working warning above -- visually empty (`sr-only`), so it never shifts layout. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <div className="flex items-center justify-end gap-1.5">
        {disabledReason && (
          <span id={reasonId} className="text-xs text-muted-foreground">
            {disabledReason}
          </span>
        )}
        <Button
          size="sm"
          aria-disabled={disabledReason !== null || committing}
          aria-describedby={describedBy}
          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
          title={disabledReason ?? undefined}
          onClick={() => void handleCommit()}
        >
          {committing ? 'Committing…' : 'Commit'}
        </Button>
      </div>
    </div>
  )
}
