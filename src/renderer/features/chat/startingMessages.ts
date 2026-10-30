// Issue #618 (Stuart, 2026-10-09): the pool of funny alternative "agent starting" messages shown in
// the chat pane while a Session's agent is coming up.
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

/** Picks a random index into a starting-message pool of `poolLength` entries, distinct from `previousIndex` when the pool has more than one entry (design note: "avoid repeating the previous pick"). */
export function pickStartingMessageIndex(previousIndex: number | undefined, poolLength: number): number {
  if (poolLength <= 1) return 0
  let next = Math.floor(Math.random() * poolLength)
  if (next === previousIndex) {
    next = (next + 1 + Math.floor(Math.random() * (poolLength - 1))) % poolLength
  }
  return next
}
