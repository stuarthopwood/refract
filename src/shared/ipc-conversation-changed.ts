// A Session's current Conversation changed without the renderer asking (#1861). `ipc.ts` is at its line cap.

export const IPC_CONVERSATION_EVENTS = {
  SESSION_CONVERSATION_CHANGED: 'session:conversation-changed'
} as const

export interface ConversationChangedPayload {
  sessionId: string
}

declare module './ipc' {
  interface RefractApi {
    onSessionConversationChanged(handler: (payload: ConversationChangedPayload) => void): () => void
  }
}
