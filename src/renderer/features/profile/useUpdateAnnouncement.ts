// Speaks the profile menu's update label when it moves to a new state, through the profile item's own polite live region.
import { useEffect, useRef } from 'react'
import { updateAnnouncement } from '@/lib/updateStatus'
import type { UpdateState } from '../../../shared/updates'

export function useUpdateAnnouncement(state: UpdateState | null, announce: (text: string) => void): void {
  const message = updateAnnouncement(state)
  // Seeded with the first render's message so an update that was already pending at launch is not read out.
  const lastMessage = useRef(message)
  useEffect(() => {
    if (lastMessage.current === message) return
    lastMessage.current = message
    if (message !== null) announce(message)
  }, [message, announce])
}
