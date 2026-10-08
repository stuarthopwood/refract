// Issue #512 requirement 1: "Starting agent… N s" text for the staged ready-wait, shared by
// `SessionList.tsx` (the row) and `ChatPane.tsx` (the banner) so neither file has to import the
// other (same reasoning as `sessionDisplay.tsx`'s own split).

import type { SessionStartProgress } from '../../../shared/model'

/** Elapsed time is rounded to whole seconds; `queued`/`memory-deferred` have no ceiling-relative
 * elapsed worth showing a count for (both are bounded, short, and secondary to the ready-wait
 * itself). */
export function describeStartProgress(progress: SessionStartProgress): string {
  switch (progress.kind) {
    case 'queued':
      return 'Waiting to start…'
    case 'memory-deferred':
      return 'Starting agent… waiting for memory to free up'
    case 'waiting':
    case 'prompt':
    case 'extended':
      return `Starting agent… ${Math.round(progress.elapsedMs / 1000)}s`
  }
}

/** Gate-fixes a11y Low finding (cycle 6): a single source for the static sr-only status word
 * that pairs with the ticking `aria-hidden` text above -- `SessionList.tsx`'s row and
 * `ChatPane.tsx`'s banner title each used to hand-write their own 'queued'-only distinction
 * ("Waiting to start" vs "Starting agent"), both silently ignoring 'memory-deferred', whose
 * visible text says "waiting for memory to free up" while the spoken status still claimed
 * "Starting agent". */
export function describeStartProgressLabel(kind: SessionStartProgress['kind']): string {
  switch (kind) {
    case 'queued':
      return 'Waiting to start'
    case 'memory-deferred':
      return 'Waiting for memory'
    case 'waiting':
    case 'prompt':
    case 'extended':
      return 'Starting agent'
  }
}
