// `/new <prompt>` composer rules (#1827, FR-208 to FR-210): pure so they are tested without mounting the composer.
import { parseSlashCommand } from '../../../shared/slash-commands'
import type { ParsedSlashCommand } from '../../../shared/slash-commands'

/** `chat.send`'s `AfterNew` stage: the new Conversation exists but the first message did not go. */
export const NEW_PROMPT_SEND_FAILED = 'new-prompt-send-failed'

export const SLASH_FILES_REFUSAL = "Slash commands can't carry attached files. Remove them and try again."

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

/** The draft to restore after an `AfterNew` failure: the prompt alone, so a retry never starts another Conversation (FR-209). */
export function promptWithoutNewCommand(draftText: string): string {
  return parseSlashCommand(draftText)?.rest ?? draftText
}
