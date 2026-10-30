import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { focusedPaneSessionId } from '@/features/sessions/newSessionInFocusedPane'
import { notify } from '@/state'
import type { PaletteConversations } from './paletteItems'

/** Loads the focused Session's Conversations each time the palette opens; null when there are none to show. */
export function usePaletteConversations(open: boolean): PaletteConversations | null {
  const [loaded, setLoaded] = useState<PaletteConversations | null>(null)
  useEffect(() => {
    if (!open) return
    const sessionId = focusedPaneSessionId()
    if (!sessionId) return
    let cancelled = false
    void window.refract.conversations
      .list(sessionId)
      .then((result) => {
        if (cancelled) return
        if (!result.ok) {
          notify(result.error)
          return
        }
        setLoaded({ sessionId, conversations: result.value })
      })
      .catch((err: unknown) => {
        if (!cancelled) toast.error(err instanceof Error ? err.message : String(err), { duration: Infinity, closeButton: true })
      })
    return () => {
      cancelled = true
      setLoaded(null)
    }
  }, [open])
  return loaded
}
