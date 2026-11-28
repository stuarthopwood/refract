/** Stage number by Stage key. */
export type StageNumbers = ReadonlyMap<string, number>

/** The Stage identity every surface shares: the launching message, else the call. Two `task()` calls in one message are one Stage. */
export function stageKeyOf(messageId: string | undefined, toolCallId: string): string {
  return messageId || toolCallId
}

/** Numbers Stages in Session start order; a repeated key keeps its first number. */
export function numberStages(stageKeysInStartOrder: readonly string[]): StageNumbers {
  const numbers = new Map<string, number>()
  for (const key of stageKeysInStartOrder) {
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1)
  }
  return numbers
}

// Pure, so card and panel agree; a summary-only Stage can take a later number when the transcript gains a newer one.
export function numberSessionStages(
  items: readonly { toolCallId: string; messageId?: string }[],
  summaries: readonly { toolCallId: string; stageKey?: string }[]
): StageNumbers {
  return numberStages([
    ...items.map((item) => stageKeyOf(item.messageId, item.toolCallId)),
    ...summaries.map((summary) => stageKeyOf(summary.stageKey, summary.toolCallId))
  ])
}

/** `next`, or `previous` when it holds the same numbers, so a memo keyed on the map is not invalidated by a rebuild that changed nothing. */
export function reuseStageNumbers(previous: StageNumbers | undefined, next: StageNumbers): StageNumbers {
  if (!previous || previous.size !== next.size) return next
  for (const [key, value] of next) {
    if (previous.get(key) !== value) return next
  }
  return previous
}
