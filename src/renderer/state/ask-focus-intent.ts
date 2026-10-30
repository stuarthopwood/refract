import { focusPaneContent, isFocusStranded } from '@/lib/focus';

// Module-level, not React state: the Ask card is swapped out by a parent before its own cleanup can focus anything.
const pending = new Set<string>();

/** Records that focus was inside the Ask card when it resolved; no-op for an undefined key. */
export function markAskFocusPending(key: string | undefined): void {
  if (!key) return;
  pending.add(key);
}

/** Returns whether `key` had a pending focus intent and clears it either way. */
export function consumeAskFocusPending(key: string | undefined): boolean {
  if (!key) return false;
  const had = pending.has(key);
  pending.delete(key);
  return had;
}

/** Marks `key`, then expires it after one frame, rescuing stranded focus into the chat pane. */
export function markAskFocusPendingWithFallback(key: string | undefined, sessionId: string | undefined): void {
  if (!key) return;
  markAskFocusPending(key);
  requestAnimationFrame(() => {
    if (!consumeAskFocusPending(key)) return;
    const pane = sessionId ? document.querySelector<HTMLElement>(`[data-session-pane="${CSS.escape(sessionId)}"]`) : null;
    if (isFocusStranded(document.activeElement, pane)) focusPaneContent(pane);
  });
}
