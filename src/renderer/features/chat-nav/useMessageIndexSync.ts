import * as React from 'react'
import type { TranscriptItem } from '../../../shared/model'
import { useChatNavStore } from '@/state/chat-nav-store'
import { buildMessageIndex } from './messageIndex'

const INDEX_THROTTLE_MS = 200

/** Keeps the Session's navigable-message index in step with its FULL transcript. A streamed
 * chunk rebuilds at most once per throttle window (leading edge immediate, trailing edge last). */
export function useMessageIndexSync(sessionId: string, items: readonly TranscriptItem[]): void {
  const latestItems = React.useRef(items)
  latestItems.current = items
  const lastRun = React.useRef(0)
  const timer = React.useRef<number | undefined>(undefined)

  React.useEffect(() => {
    const publish = () => {
      lastRun.current = Date.now()
      timer.current = undefined
      useChatNavStore.getState().setIndex(sessionId, buildMessageIndex(latestItems.current))
    }
    const wait = INDEX_THROTTLE_MS - (Date.now() - lastRun.current)
    if (wait <= 0) publish()
    else if (timer.current === undefined) timer.current = window.setTimeout(publish, wait)
  }, [sessionId, items])

  React.useEffect(
    () => () => {
      clearTimeout(timer.current)
      timer.current = undefined
      lastRun.current = 0
    },
    [sessionId]
  )
}
