// A Session's Conversations changed (created, switched or deleted): the header switcher and the Session row's
// nested list are separate views of the same files, so each tells the other when to re-read.
const listeners = new Set<(sessionId: string) => void>()

export function emitConversationsChanged(sessionId: string): void {
  for (const listener of [...listeners]) listener(sessionId)
}

/** Returns the unsubscribe function. */
export function subscribeConversationsChanged(listener: (sessionId: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
