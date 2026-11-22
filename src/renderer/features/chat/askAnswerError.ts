import type { IpcError } from '../../../shared/ipc'
import { notify } from '@/state'

export const REQUEST_GONE_MESSAGE = "That question was already closed, so your answer wasn't sent."

/**
 * The text for a failed `chat.answer`. A late answer to a closed question also raises a toast,
 * because the card unmounts as soon as the host reports it resolved and would never show the error.
 */
export function answerFailureText(error: IpcError): string {
  if (error.code === 'request-gone') {
    notify({ code: error.code, message: REQUEST_GONE_MESSAGE })
    return REQUEST_GONE_MESSAGE
  }
  if (/customInput exceeds \d+ characters/.test(error.message)) return 'Your answer is too long. Shorten it and try again.'
  return error.message
}
