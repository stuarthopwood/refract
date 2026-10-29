// Pause mode (#477): the renderer-side calls behind every pause control (row menu, chat header,
// footer Pause all / Resume all, `/pause`'s Space twin). One place, so a failure reads the same
// everywhere: a notice carrying the backend's own error text.

import { notify } from '@/state'

export function canTogglePause(session: { status: string; pause?: string }): boolean {
  return session.status !== 'stopped' || !!session.pause
}

export async function setSessionPaused(sessionId: string, paused: boolean): Promise<boolean> {
  const result = paused ? await window.refract.chat.pause(sessionId) : await window.refract.chat.resume(sessionId)
  if (!result.ok) notify({ code: result.error.code, message: result.error.message })
  return result.ok
}

export async function setAllPaused(paused: boolean): Promise<void> {
  const result = paused ? await window.refract.chat.pauseAll() : await window.refract.chat.resumeAll()
  if (!result.ok) {
    notify({ code: result.error.code, message: result.error.message })
    return
  }
  const failed = (result.value as { failed?: number }).failed ?? 0
  if (failed > 0) {
    notify({
      code: 'agent-not-running',
      message: `${failed} paused ${failed === 1 ? 'session' : 'sessions'} could not resume (start the agent first, or see the notice). Resume ${failed === 1 ? 'it' : 'them'} from the session.`
    })
  }
}
