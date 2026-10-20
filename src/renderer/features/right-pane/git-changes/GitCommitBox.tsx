// Spec 018 slice 1 (issue #464), User Story 2: the panel's fixed, non-scrolling commit-box
// footer (FR-009 to FR-013, FR-023, FR-024) -- a subject field with a live character counter, a
// body field, and a Commit button, disabled with exactly one visible reason whenever nothing is
// staged or the message is empty (`disabled` + `title` + a visible reason line, the same
// disabled-with-reason convention `PullRequestDetail.tsx`'s own Merge button already uses).
// Ctrl+Enter from anywhere in either field commits (matching the composer's own send shortcut).
// A quiet inline warning shows whenever the focused Session's status is `working`, without
// disabling Commit on that basis alone (FR-012); any stage/unstage/commit failure (the store's
// one shared `error` field) surfaces here as a plain inline `role="alert"` (FR-013), the one
// place this panel announces an alert so a load failure and an action failure are never
// double-announced in two places at once.
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
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [committing, setCommitting] = useState(false)
  const subjectId = useId()
  const bodyId = useId()

  const stagedCount = entry?.snapshot?.groups.staged.length ?? 0
  const trimmedSubject = subject.trim()
  const trimmedBody = body.trim()
  // FR-009: subject + blank line + body, the conventional git shape -- FR-024 still holds (no
  // format is ENFORCED; a bare body with no subject, or vice versa, is composed as-is below).
  const message = trimmedSubject && trimmedBody ? `${trimmedSubject}\n\n${trimmedBody}` : trimmedSubject || trimmedBody
  const disabledReason = stagedCount === 0 ? 'Nothing staged' : message.length === 0 ? 'Write a message' : null

  async function handleCommit(): Promise<void> {
    if (disabledReason || committing) return
    setCommitting(true)
    await useGitChangesStore.getState().commit(sessionId, message)
    setCommitting(false)
    // `runAction` (git-changes-store.ts) clears `error` to `null` on a genuine success (it calls
    // `load`, which always resets it) -- reading it fresh here, rather than trusting a local
    // "it resolved" flag, is how a real failure (which sets a non-null `error` instead) is told
    // apart from success without the store returning a redundant boolean of its own.
    if (useGitChangesStore.getState().bySession[sessionId]?.error === null) {
      setSubject('')
      setBody('')
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): void {
    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault()
      void handleCommit()
    }
  }

  return (
    <div className="no-drag-region flex shrink-0 flex-col gap-1.5 border-t border-divider p-2">
      {sessionStatus === 'working' && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
          Agent is working -- review before committing
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <label htmlFor={subjectId} className="sr-only">
          Commit subject
        </label>
        <Input
          id={subjectId}
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
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
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Description (optional)"
        className="min-h-12 text-sm"
      />
      {entry?.error && (
        <p role="alert" className="text-xs text-destructive">
          {entry.error}
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5">
        {disabledReason && <span className="text-xs text-muted-foreground">{disabledReason}</span>}
        <Button size="sm" disabled={disabledReason !== null || committing} title={disabledReason ?? undefined} onClick={() => void handleCommit()}>
          {committing ? 'Committing…' : 'Commit'}
        </Button>
      </div>
    </div>
  )
}
