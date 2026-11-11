/** The ask-focus intent key; the same `${sessionId}:${id}` shape `AskCard` and `AskQuestionRow` use, with the ask item id as the id. */
export function askFormIntentKey(sessionId: string | undefined, askItemId: string | undefined): string | undefined {
  return sessionId && askItemId ? `${sessionId}:${askItemId}` : undefined
}
