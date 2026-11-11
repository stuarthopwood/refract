import * as React from 'react'
import { consumeAskFocusPending } from '@/state/ask-focus-intent'
import { isFocusStranded } from '@/lib/focus'
import { askFormIntentKey } from './askFormIntentKey'

/** For the row that replaces the live card: takes focus when the card armed the intent and focus is stranded. */
export function useClaimAskFormFocus(ref: React.RefObject<HTMLElement | null>, sessionId: string | undefined, askItemId: string | undefined): void {
  const intentKey = askFormIntentKey(sessionId, askItemId)
  React.useLayoutEffect(() => {
    if (consumeAskFocusPending(intentKey) && isFocusStranded(document.activeElement, null)) ref.current?.focus()
  }, [intentKey, ref])
}
