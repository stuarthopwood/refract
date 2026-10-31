import { useId, useState } from 'react'
import { cn } from '@/lib/utils'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { TriangleAlertIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useGitChangesStore, useSessionsStore } from '@/state'
import { COMPOSER_INPUT_SURFACE_CLASS } from '@/features/chat/pickerShared'
import { DEFAULT_COMMIT_DRAFT } from '@/state/git-changes-store'

export function GitCommitBox({ sessionId }: { sessionId: string }) {
  const entry = useGitChangesStore((s) => s.bySession[sessionId])
  const draft = useGitChangesStore((s) => s.commitDraftsBySession[sessionId] ?? DEFAULT_COMMIT_DRAFT)
  const sessionStatus = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId)?.status)
  const subject = draft.subject
  const body = draft.body
  const [committing, setCommitting] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const subjectId = useId()
  const counterId = useId()
  const bodyId = useId()
  const warningId = useId()
  const reasonId = useId()

  function updateDraft(partial: Partial<{ subject: string; body: string }>): void {
    useGitChangesStore.getState().setCommitDraft(sessionId, { subject, body, ...partial })
  }

  function announce(text: string): void {
    setAnnouncement('')
    requestAnimationFrame(() => setAnnouncement(text))
  }

  const conflictCount = entry?.snapshot?.groups.conflicts.length ?? 0
  const stagedCount = entry?.snapshot?.groups.staged.length ?? 0
  const trimmedSubject = subject.trim()
  const trimmedBody = body.trim()
  const message = trimmedSubject && trimmedBody ? `${trimmedSubject}\n\n${trimmedBody}` : trimmedSubject || trimmedBody
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
    const submittedDraft = { subject, body }
    setCommitting(true)
    const result = await useGitChangesStore.getState().commit(sessionId, message)
    setCommitting(false)
    if (result.ok) {
      // Only clear the draft if it still equals what was actually submitted -- a developer may
      // have started typing a NEW message during the async commit window, and that must survive.
      const currentDraft = useGitChangesStore.getState().commitDraftsBySession[sessionId]
      if (currentDraft && currentDraft.subject === submittedDraft.subject && currentDraft.body === submittedDraft.body) {
        useGitChangesStore.getState().setCommitDraft(sessionId, { subject: '', body: '' })
      }
      announce(`Committed: ${committedSubject}`)
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
    <div className="no-drag-region flex shrink-0 flex-col gap-2 border-t border-divider p-2">
      {sessionStatus === 'working' && (
        <p id={warningId} role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
          Agent is working — review before committing
        </p>
      )}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <label htmlFor={subjectId} className="sr-only">
            Commit subject
          </label>
          {/* Gate round 1 UI review (#1101): the counter used to be a flex SIBLING of the input,
              narrowing it by its own width (~37px) the instant typing started. It now sits
              absolutely positioned INSIDE the input's own box (over its `pr-12` right padding),
              so the field's own width never changes. */}
          <div className="relative flex-1">
            <Input
              id={subjectId}
              value={subject}
              onChange={(event) => updateDraft({ subject: event.target.value })}
              onKeyDown={handleKeyDown}
              placeholder="Commit subject"
              aria-describedby={subject.length > 0 ? counterId : undefined}
              className={cn('pr-12', COMPOSER_INPUT_SURFACE_CLASS)}
            />
            {/* Item 1 (#1101): hidden on an empty field (no bare "0"), `n/72` once typing
                starts, muted until past 50 (warning colour) and past 72 (error colour, visual
                only -- FR-024/FR-009 still never block Commit on subject length). The sr-only
                "Subject length" prefix shares this SAME element's accessible text with the
                visible count, and the input's own `aria-describedby` above links to it too
                (gate round 1 LOW 5) -- nothing else needs to read it separately. Low items
                (#1111): the two tiers used to be colour alone -- the sr-only prefix now names
                each tier in words too (so a screen reader is never left with only "72/72"), and
                a visible line below the field (not inside this absolutely-positioned counter,
                so it never narrows the input) spells out the over-72 tier for a sighted,
                non-colour-distinguishing user. */}
            {subject.length > 0 && (
              <span
                id={counterId}
                className={cn(
                  'pointer-events-none absolute right-2 top-1/2 shrink-0 -translate-y-1/2 text-xs tabular-nums',
                  subject.length > 72 ? 'text-severity-error' : subject.length > 50 ? 'text-severity-warning' : 'text-muted-foreground'
                )}
              >
                <span className="sr-only">
                  Subject length{' '}
                  {subject.length > 72
                    ? '(over the recommended limit — the commit still goes through) '
                    : subject.length > 50
                      ? '(approaching the recommended limit) '
                      : ''}
                </span>
                {subject.length}/72
              </span>
            )}
          </div>
        </div>
        {/* #1111 gate round 2 LOW: `text-muted-foreground`, not `text-severity-error` -- this
            note is advisory (the commit still goes through), never a blocking error; the
            counter's OWN digits above still use the error tier colour for the over-72 figure
            itself, unchanged. */}
        {subject.length > 72 && <p className="text-xs text-muted-foreground">Over 72 characters — the commit still goes through.</p>}
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
        className={cn('max-h-32 min-h-12 overflow-y-auto text-sm', COMPOSER_INPUT_SURFACE_CLASS)}
      />
      {entry?.actionError && (
        <div className="flex items-start gap-2">
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
          agent-working warning above -- visually empty (`sr-only`), so it never shifts layout.
          Gate round 3 fix (#1076 LOW 5, Main's correction): a single ALWAYS-MOUNTED node, never
          `key`-remounted -- a screen reader can skip a live region whose text is already present
          the instant it mounts. `announce()` above clears then sets on the next frame instead,
          a genuine two-step mutation of this SAME node. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <div className="flex items-center justify-end gap-2">
        {disabledReason && (
          <span id={reasonId} className="text-xs text-muted-foreground">
            {disabledReason}
          </span>
        )}
        <Button
          size="sm"
          aria-disabled={disabledReason !== null || committing}
          aria-describedby={describedBy}
          className="aria-disabled:opacity-50"
          title={disabledReason ?? undefined}
          onClick={() => void handleCommit()}
        >
          {committing ? 'Committing…' : 'Commit'}
        </Button>
      </div>
    </div>
  )
}
