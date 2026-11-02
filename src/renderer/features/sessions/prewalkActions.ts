import { notify } from '@/state'

/** Sends OMP's own `/prewalk` or `/prewalk off`; the menu label follows OMP's reply, not this call (#695). */
export async function setPrewalk(sessionId: string, arm: boolean): Promise<void> {
  const result = await window.refract.chat.send(sessionId, arm ? '/prewalk' : '/prewalk off')
  if (!result.ok) notify({ code: result.error.code, message: result.error.message })
}
