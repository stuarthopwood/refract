import type { IpcError } from '../../../shared/ipc'
import { notifyInfo } from '@/state'

export const REQUEST_GONE_MESSAGE = "That question was already closed, so your answer wasn't sent."
export const REQUEST_GONE_CANCEL_MESSAGE = 'That question was already closed, so there was nothing to cancel.'

/**
 * The text for a failed `chat.answer`. A late answer or cancel on a closed question also raises an info
 * toast with an assertive announcement, because the card unmounts as soon as the host reports it
 * resolved and would never show the error.
 */
export function answerFailureText(error: IpcError, action: 'answer' | 'cancel' = 'answer'): string {
  if (error.code === 'request-gone') {
    const message = action === 'cancel' ? REQUEST_GONE_CANCEL_MESSAGE : REQUEST_GONE_MESSAGE
    notifyInfo(message)
    return message
  }
  if (/customInput exceeds \d+ characters/.test(error.message)) return 'Your answer is too long. Shorten it and try again.'
  return error.message
}
