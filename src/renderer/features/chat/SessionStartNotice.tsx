import type { RefObject } from 'react'
import { LoaderCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SessionStartProgress } from '../../../shared/model'
import { describeStartProgress, describeStartProgressLabel } from '@/features/sessions/startProgressDisplay'

interface SessionStartNoticeProps {
  startProgress: SessionStartProgress
  /** Picked joke message and emoji; undefined before the first pick and for queued/memory-deferred. */
  message: string | undefined
  emoji: string | undefined
  cancelButtonRef: RefObject<HTMLButtonElement | null>
  onKeepWaiting: () => void
  onCancel: () => void
  /** Set by `Transcript.tsx` when overlaying the blurred history: adds a panel for text contrast. */
  dimmed?: boolean
}

// The joke is aria-hidden; the sr-only label stays the static progress text. The emoji bob runs
// 2 iterations (under 5s, WCAG 2.2.2).
/** Centred notice shown while a session starts, with Keep waiting/Cancel controls once it drags on. */
export function SessionStartNotice({
  startProgress,
  message,
  emoji,
  cancelButtonRef,
  onKeepWaiting,
  onCancel,
  dimmed
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
        'flex flex-col items-center gap-2 text-center',
        dimmed ? 'rounded-xl bg-background/90 px-6 py-4 backdrop-blur-sm @max-h-[28rem]:py-4' : 'px-2 py-8 @max-h-[28rem]:py-4'
      )}
    >
      {hasJoke ? (
        <div className="flex flex-col items-center gap-2">
          <span
            aria-hidden="true"
            data-start-emoji
            className="block text-emoji leading-none animate-[session-start-emoji-bob_2.4s_ease-in-out_2] @min-[40rem]:text-5xl"
          >
            {emoji}
          </span>
          <p className="flex max-w-[28rem] flex-col items-center gap-1 text-xl text-balance text-foreground @min-[40rem]:text-2xl">
            <span className="sr-only">{describeStartProgressLabel(startProgress.kind)}</span>
            <span aria-hidden="true" data-start-message>{message}</span>
            <span aria-hidden="true" data-start-counter className="text-xs font-normal text-muted-foreground tabular-nums">
              {Math.round(startProgress.elapsedMs / 1000)}s
            </span>
          </p>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-base text-muted-foreground">
          <span className="sr-only">{describeStartProgressLabel(startProgress.kind)}</span>
          <LoaderCircleIcon aria-hidden="true" className="size-4 shrink-0 animate-spin" />
          <span aria-hidden="true" data-start-plain-text>{describeStartProgress(startProgress)}</span>
        </p>
      )}
      {showControls && (
        <>
          <p data-start-guidance className="text-sm text-muted-foreground">
            {startProgress.kind === 'prompt'
              ? 'Still starting. Keep waiting, or cancel?'
              : startProgress.kind === 'extended'
                ? 'Still starting. Cancel to stop waiting.'
                : 'Cancel to stop waiting.'}
          </p>
          <div className="flex gap-2">
            {startProgress.kind === 'prompt' && (
              <Button type="button" size="sm" variant="ghost" onClick={onKeepWaiting}>
                Keep waiting
              </Button>
            )}
            <Button type="button" ref={cancelButtonRef} size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
