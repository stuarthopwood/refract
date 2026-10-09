// Issue #618 (Stuart, 2026-10-09): the chat pane's 'agent starting' message, unboxed (no Alert
// card, no bordered strip -- Stuart does not like the box). Shared by ChatPane.tsx (a quiet
// line above the composer, for a Session with history or a conversation already underway) and
// Transcript.tsx (centred in the empty transcript area, for a genuinely brand-new Session with
// neither) -- gate-fix (round 4): ChatPane.tsx's own `showInline` (`hasHistory ||
// conversationStarted`, not `hasHistory` alone) decides which placement applies, renders exactly
// one of the two, never both and never alongside "Ready...".
//
// queued/memory-deferred keep the existing plain, truthful text (describeStartProgress) and
// the original small spinning LoaderCircleIcon (global prefers-reduced-motion CSS already
// neutralises it, src/renderer/styles/globals.css:591) -- no joke, since that text explains why
// nothing is happening yet. The random pool only applies to waiting/prompt/extended: each uses
// its own picked message's leading emoji as the one glyph (replacing the spinner for this stage
// -- one glyph reads cleaner than a spinner plus a separate emoji) with the elapsed seconds
// appended quietly after. The emoji and the rest of the joke text are aria-hidden together; the
// static sr-only label (describeStartProgressLabel) is unchanged, so a screen reader still hears
// "Starting agent"/"Waiting to start"/"Waiting for memory", never the joke itself.
//
// Gate-fix (a11y/code/verif Medium, round 2): restores two things the issue only ever asked to
// remove the BOX around, not remove outright -- `role="group" aria-label="Agent start"` (so a
// screen-reader user tabbing or browsing by buttons still hears what group Keep waiting/Cancel
// belong to, not a bare "Keep waiting"/"Cancel" with no context) and the old Alert's own visible
// guidance sentence above those buttons (sighted users previously got nothing but bare buttons
// next to a joke).
import type { RefObject } from 'react'
import { LoaderCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SessionStartProgress } from '../../../shared/model'
import { describeStartProgress, describeStartProgressLabel } from '@/features/sessions/startProgressDisplay'

interface SessionStartNoticeProps {
  startProgress: SessionStartProgress
  /** The picked joke message's own text and leading emoji (ChatPane.tsx owns the
   * once-per-start pick, startingMessages.ts). Both undefined during the brief gap before the
   * very first pick lands, or whenever startProgress.kind is queued/memory-deferred, which
   * never draw from the pool at all. */
  message: string | undefined
  emoji: string | undefined
  cancelButtonRef: RefObject<HTMLButtonElement | null>
  onKeepWaiting: () => void
  onCancel: () => void
  /** Transcript.tsx's centred empty-area placement (brand-new Session) versus ChatPane.tsx's
   * quiet line above the composer (Session with history). */
  variant: 'centered' | 'inline'
}

export function SessionStartNotice({
  startProgress,
  message,
  emoji,
  cancelButtonRef,
  onKeepWaiting,
  onCancel,
  variant
}: SessionStartNoticeProps) {
  const isJokeStage = startProgress.kind === 'waiting' || startProgress.kind === 'prompt' || startProgress.kind === 'extended'
  const hasJoke = isJokeStage && !!message
  const showControls =
    startProgress.kind === 'prompt' ||
    startProgress.kind === 'extended' ||
    startProgress.kind === 'queued' ||
    startProgress.kind === 'memory-deferred'
  return (
    <div
      data-pane-banner
      role="group"
      aria-label="Agent start"
      className={cn(
        'flex flex-col gap-2 text-sm text-muted-foreground',
        variant === 'centered' ? 'items-center px-2 py-8 text-center' : 'shrink-0 px-4 pt-3'
      )}
    >
      <p className="flex items-center gap-1.5">
        <span className="sr-only">{describeStartProgressLabel(startProgress.kind)}</span>
        {isJokeStage && emoji ? (
          <span aria-hidden="true">{emoji}</span>
        ) : (
          <LoaderCircleIcon aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
        )}
        {hasJoke ? (
          <span aria-hidden="true">
            {message}{' '}
            {/* Gate-fixes verif Low finding: the ticking counter reads quieter than the joke
                itself -- smaller text only (same text-muted-foreground colour the whole notice
                already uses, so no new contrast pair for check:theme-contrast to verify). */}
            <span className="text-xs tabular-nums">{Math.round(startProgress.elapsedMs / 1000)}s</span>
          </span>
        ) : (
          <span aria-hidden="true">{describeStartProgress(startProgress)}</span>
        )}
      </p>
      {showControls && (
        <>
          <p>
            {startProgress.kind === 'prompt'
              ? 'Still starting. Keep waiting, or cancel?'
              : startProgress.kind === 'extended'
                ? 'Still starting. Cancel to stop waiting.'
                : 'Cancel to stop waiting.'}
          </p>
          <div className="flex gap-2">
            {startProgress.kind === 'prompt' && (
              <Button type="button" size="sm" variant="outline" onClick={onKeepWaiting}>
                Keep waiting
              </Button>
            )}
            <Button type="button" ref={cancelButtonRef} size="sm" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
