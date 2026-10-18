// Issue #672 (Stuart, 2026-10-11, "essential to have some fun"; follow-up to #618): one centred
// presentation for every Session start, not two. `ChatPane.tsx` now renders this unconditionally
// inside `Transcript.tsx`'s centred overlay, for a brand-new Session and a Session with history
// alike; the old `inline` variant (a quiet `text-sm` line above the composer, shown whenever a
// Session had history) is gone, along with the `variant` prop that used to choose between the
// two. `Transcript.tsx` dims the history behind this notice to about 40% opacity for the
// Session-with-history case (its own `dimTranscript`) and calls this as a render function,
// `startNotice(dimmed)` (below), so it can back itself with a solid-reading panel -- otherwise
// the notice's own text would sit directly on the dimmed, lower-contrast history behind it.
// Gate-fix (UI/A11y, gate round 1): the transcript itself stays interactive and scrollable
// throughout (mouse wheel, selection, links) -- `Transcript.tsx` no longer disables
// pointer-events on it, only fades it, and restores full opacity the moment a focusable element
// inside it is focused (`focus-within:opacity-100`). Gate-fix (A11y, gate round 2, WCAG 2.4.11):
// that same focus also hides THIS notice (`Transcript.tsx`'s own overlay, not a prop here, gets
// `peer-focus-within:opacity-0`; corrected round 3, that class lives on the overlay sibling,
// never a descendant, per Tailwind's own sibling-combinator compile) so the panel can never sit
// on top of a focused history control; Tab reaching Keep waiting/Cancel moves focus OUT of the
// history, which brings the
// notice straight back in the same frame -- see `Transcript.tsx` for why `opacity`, not
// `visibility`, is what hides it (the latter would make those buttons untabbable).
//
// Sizing (#672): the joke-stage message (`waiting`/`prompt`/`extended` once a message has been
// picked) renders its emoji on its own line at `text-[40px]` (`@min-[40rem]:text-5xl`, about
// 48px once the pane is wide enough) and the message itself at `text-xl`
// (`@min-[40rem]:text-2xl`, about 24px), in the normal foreground colour -- not muted, unlike
// every other line here -- with `max-w-[28rem]` and `text-balance` so a long message such as
// "Turning the agent off and on again…" actually wraps evenly rather than ragged (text-balance
// has nothing to balance against without a bounded width), and a slow bob
// (`session-start-emoji-bob`, globals.css) on the emoji in BOTH sizing regimes, neutralised by
// the global `prefers-reduced-motion` rule the same way the spinner below already is. Gate-fix
// (A11y, gate round 2, WCAG 2.2.2): the bob runs exactly 2 iterations (about 4.8s total, under
// the 5s threshold) rather than looping forever, so it is never an indefinitely-repeating motion
// a user has no way to stop.
// `queued`/`memory-deferred` (and the brief gap before a start's very first pick lands) keep the
// original small `text-base` spinner-plus-text look, unchanged by this issue -- they explain a
// delay rather than entertain, so they stay plain and quiet. The elapsed-seconds counter after
// the joke stays small and quiet (`text-xs text-muted-foreground`, now explicit since the message
// around it is no longer muted).
//
// Gate-fix (UI, gate round 1): on a short pane, `@max-h-[28rem]` trims this component's own
// vertical padding (`py-8`/`py-4` down to `py-4`/`py-3`) -- paired with `Transcript.tsx`'s own
// `items-center-safe` overlay (falls back to top-aligned, then scrolls, rather than clipping
// Keep waiting/Cancel off the top) -- so the larger #672 sizing never pushes those controls out
// of reach.
//
// The random pool only applies to waiting/prompt/extended: each uses its own picked message's
// leading emoji as the one glyph (replacing the spinner for this stage -- one glyph reads
// cleaner than a spinner plus a separate emoji). The emoji and the rest of the joke text are
// aria-hidden together; the static sr-only label (describeStartProgressLabel) is unchanged, so a
// screen reader still hears "Starting agent"/"Waiting to start"/"Waiting for memory", never the
// joke itself.
//
// Gate-fix (a11y/code/verif Medium, round 2, issue #618): restores two things the issue only ever
// asked to remove the BOX around, not remove outright -- `role="group" aria-label="Agent start"`
// (so a screen-reader user tabbing or browsing by buttons still hears what group Keep
// waiting/Cancel belong to, not a bare "Keep waiting"/"Cancel" with no context) and the old
// Alert's own visible guidance sentence above those buttons (sighted users previously got nothing
// but bare buttons next to a joke).
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
  /** Set by `Transcript.tsx` via `React.cloneElement` (never by `ChatPane.tsx`, which has no
   * opinion on dimming) -- true for the Session-with-history case, where this notice overlays
   * the dimmed transcript rather than empty space. Backs the notice with a soft, borderless
   * panel (`bg-background/90 backdrop-blur-sm`, the same token the file-drop overlay uses,
   * `ChatPane.tsx`'s own `isDraggingFiles` block) so its text keeps full contrast against the
   * dimmed history behind it; a brand-new Session (nothing behind) gets no panel. */
  dimmed?: boolean
}

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
        'flex flex-col items-center gap-3 text-center',
        dimmed ? 'rounded-xl bg-background/90 px-6 py-4 backdrop-blur-sm @max-h-[28rem]:py-3' : 'px-2 py-8 @max-h-[28rem]:py-4'
      )}
    >
      {hasJoke ? (
        <div className="flex flex-col items-center gap-2">
          <span
            aria-hidden="true"
            data-start-emoji
            className="block text-[40px] leading-none animate-[session-start-emoji-bob_2.4s_ease-in-out_2] @min-[40rem]:text-5xl"
          >
            {emoji}
          </span>
          <p className="flex max-w-[28rem] flex-col items-center gap-1 text-xl text-balance text-foreground @min-[40rem]:text-2xl">
            <span className="sr-only">{describeStartProgressLabel(startProgress.kind)}</span>
            <span aria-hidden="true" data-start-message>{message}</span>
            {/* Gate-fixes verif Low finding: the ticking counter reads quieter than the joke
                itself -- smaller text and explicitly muted now that the message around it has
                moved off `text-muted-foreground` onto the normal foreground colour (#672), so no
                new contrast pair for check:theme-contrast to verify (still the same
                muted-foreground/background pair, now also checked against the dimmed panel's
                `bg-background/90` live by `verify-672-start-message.mjs`). */}
            <span aria-hidden="true" data-start-counter className="text-xs font-normal text-muted-foreground tabular-nums">
              {Math.round(startProgress.elapsedMs / 1000)}s
            </span>
          </p>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-base text-muted-foreground">
          <span className="sr-only">{describeStartProgressLabel(startProgress.kind)}</span>
          <LoaderCircleIcon aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
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
