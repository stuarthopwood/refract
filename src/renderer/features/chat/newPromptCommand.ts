// `/new <prompt>` composer rules (#1827, FR-208 to FR-210): pure so they are tested without mounting the composer.
import { parseSlashCommand } from '../../../shared/slash-commands'
import type { ParsedSlashCommand } from '../../../shared/slash-commands'

/** `chat.send`'s `AfterNew` stage: the new Conversation exists but the first message did not go. */
export const NEW_PROMPT_SEND_FAILED = 'new-prompt-send-failed'

export const SLASH_FILES_REFUSAL = "Slash commands can't carry attached files. Remove them and try again."

/** The same refusal `chat.send` makes (wording mirrored): a first message starting with `/` would run as a command, unchecked. */
export const SLASH_PROMPT_REFUSAL = "A slash command can't be the first message of /new. Send the command on its own after /new."

/** `/new` with a message after it; bare `/new` keeps its own path. */
export function isNewPromptCommand(invocation: ParsedSlashCommand | undefined): boolean {
  return invocation?.name === 'new' && invocation.rest !== ''
}

/** Any `/new`, bare or with a prompt: both reset the Conversation, so both reset scroll memory. */
export function isNewConversationCommand(invocation: ParsedSlashCommand | undefined): boolean {
  return invocation?.name === 'new'
}

/** The toast text when a slash command carries something it cannot; undefined means the send may go ahead. */
export function slashAttachmentRefusal(
  invocation: ParsedSlashCommand | undefined,
  attachments: { images: readonly unknown[]; files: readonly unknown[] }
): string | undefined {
  if (!invocation) return undefined
  if (attachments.files.length > 0) return SLASH_FILES_REFUSAL
  // Images already ride `chat.send` for ordinary slash commands; only `/new <prompt>` cannot carry them (FR-210).
  if (isNewPromptCommand(invocation) && attachments.images.length > 0) return SLASH_FILES_REFUSAL
  return undefined
}

/** What may not go ahead before any Conversation starts: a slash command as the prompt, then attachments. */
export function sendRefusal(
  invocation: ParsedSlashCommand | undefined,
  attachments: { images: readonly unknown[]; files: readonly unknown[] }
): string | undefined {
  if (isNewPromptCommand(invocation) && invocation?.rest.startsWith('/')) return SLASH_PROMPT_REFUSAL
  return slashAttachmentRefusal(invocation, attachments)
}

/** The draft to restore after an `AfterNew` failure: the prompt alone, so a retry never starts another Conversation (FR-209). */
export function promptWithoutNewCommand(draftText: string): string {
  return parseSlashCommand(draftText)?.rest ?? draftText
}

/** True while the store still holds exactly what a send captured, so a later write cannot clobber what the user typed meanwhile. */
export function draftUnchangedSinceSend(
  current: { text: string; attachments: unknown } | undefined,
  sent: { text: string; attachments: unknown }
): boolean {
  return current?.text === sent.text && current?.attachments === sent.attachments
}

export type SendFailureRecovery =
  | { kind: 'restore-prompt'; text: string }
  | { kind: 'restore-scroll' }
  | { kind: 'none' }

/**
 * What the composer does after `chat.send` fails. `AfterNew` means the new Conversation exists: the bare prompt goes
 * back (FR-209) unless the user kept typing, and the old scroll position is gone for good. Any other failure of a
 * `/new` leaves the old Conversation, so its scroll position comes back.
 */
export function sendFailureRecovery(failure: {
  code: string
  newConversation: boolean
  draftText: string
  draftUnchanged: boolean
}): SendFailureRecovery {
  if (failure.code === NEW_PROMPT_SEND_FAILED) {
    return failure.draftUnchanged ? { kind: 'restore-prompt', text: promptWithoutNewCommand(failure.draftText) } : { kind: 'none' }
  }
  return failure.newConversation ? { kind: 'restore-scroll' } : { kind: 'none' }
}
