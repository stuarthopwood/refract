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
  const { count = 0, failed = 0 } = result.value as { count?: number; failed?: number }
  if (!paused && failed > 0) {
    notify({ code: 'resume-failed', message: `Resumed ${count}, ${failed} failed to start` })
  }
}
