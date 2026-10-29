export const MESSAGE_ROW_SELECTOR = '[data-message-id]'

/** The mounted row for a message id inside `root`, or null when it is not rendered. */
export function findMessageRow(root: ParentNode, messageId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
}
