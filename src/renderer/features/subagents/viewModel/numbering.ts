/** Stage number by Stage key; the key is the `toolCallId` of the Stage's first agent. */
export type StageNumbers = ReadonlyMap<string, number>

/**
 * Numbers Stages 1, 2, 3... in the order given, which must be start order across the whole Session. A key seen twice keeps its
 * first number, and a Stage that later leaves a surface (pruned, scrolled out of the transcript window) keeps its number
 * because the list is the Session's, not the surface's, so a number is never reused.
 */
export function numberStages(stageKeysInStartOrder: readonly string[]): StageNumbers {
  const numbers = new Map<string, number>()
  for (const key of stageKeysInStartOrder) {
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1)
  }
  return numbers
}

/**
 * The Session's numbering from everything that can start a Stage: transcript items first (they are in start order), then any
 * summary the transcript does not carry yet, so an agent only the live registry knows still gets a number after the transcript's.
 */
export function numberSessionStages(
  items: readonly { toolCallId: string }[],
  summaries: readonly { toolCallId: string }[]
): StageNumbers {
  return numberStages([...items, ...summaries].map((entry) => entry.toolCallId))
}

/** `next`, or `previous` when it holds the same numbers, so a memo keyed on the map is not invalidated by a rebuild that changed nothing. */
export function reuseStageNumbers(previous: StageNumbers | undefined, next: StageNumbers): StageNumbers {
  if (!previous || previous.size !== next.size) return next
  for (const [key, value] of next) {
    if (previous.get(key) !== value) return next
  }
  return previous
}
