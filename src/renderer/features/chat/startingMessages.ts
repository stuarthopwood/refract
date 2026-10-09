// Issue #618 (Stuart, 2026-10-09): the pool of funny alternative "agent starting" messages shown
// in the chat pane while a Session's agent is coming up. One is picked at random each time a
// start begins (ChatPane.tsx owns the pick-once-per-start logic; this module is pure data plus a
// pure picker). Each message names the agent so it still reads as "agent starting" even out of
// context, ends in an ellipsis, and leads with an emoji the caller renders `aria-hidden` (the
// joke text itself is never announced to screen readers; the static sr-only label stays
// `describeStartProgressLabel`, unchanged by this issue). Verbatim from the issue's own proposed
// pool -- Stuart can edit the wording later without touching the picking logic.
export const STARTING_MESSAGES: readonly string[] = [
  'Brewing the agent. Strong, no sugar…',
  'Waking the agent. It was napping…',
  'Summoning your agent…',
  "Tightening the agent's bolts…",
  "Warming up the agent's thrusters…",
  "Spinning up the agent's hamster wheel…",
  "Finding the agent's brain…",
  'Convincing the agent to show up…',
  'Beaming the agent down…',
  "Toasting the agent's tokens…",
  "Lining up the agent's ducks…",
  'Turning the agent off and on again…'
]

// Each message's own leading emoji, 1:1 with STARTING_MESSAGES by index -- kept separate from the
// text (rather than embedded in the string) so the caller can wrap just the glyph in its own
// `aria-hidden` span without string-splitting at render time.
export const STARTING_MESSAGE_EMOJI: readonly string[] = ['☕', '🦥', '🧙', '🔧', '🚀', '🐹', '🧠', '🪄', '🛸', '🍞', '🦆', '🔌']

/** Picks a random index into `STARTING_MESSAGES`, distinct from `previousIndex` when the pool has
 * more than one entry (design note: "avoid repeating the previous pick"). `previousIndex` is
 * `undefined` for the very first pick a Session ever makes (nothing to avoid repeating yet). */
export function pickStartingMessageIndex(previousIndex: number | undefined): number {
  if (STARTING_MESSAGES.length <= 1) return 0
  let next = Math.floor(Math.random() * STARTING_MESSAGES.length)
  if (next === previousIndex) {
    next = (next + 1 + Math.floor(Math.random() * (STARTING_MESSAGES.length - 1))) % STARTING_MESSAGES.length
  }
  return next
}
