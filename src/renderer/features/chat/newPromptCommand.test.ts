// `/new <prompt>` composer rules (#1827, FR-208 to FR-210).
import { describe, expect, it } from 'vitest'
import { parseSlashCommand } from '../../../shared/slash-commands'
import {
  draftUnchangedSinceSend,
  isNewConversationCommand,
  isNewPromptCommand,
  NEW_PROMPT_SEND_FAILED,
  promptWithoutNewCommand,
  sendFailureRecovery,
  sendRefusal,
  slashAttachmentRefusal,
  SLASH_FILES_REFUSAL,
  SLASH_PROMPT_REFUSAL
} from './newPromptCommand'

const none = { images: [], files: [] }
const withImage = { images: [{}], files: [] }
const withFile = { images: [], files: [{}] }

describe('isNewPromptCommand', () => {
  it('is true for /new with a message and false for bare /new', () => {
    expect(isNewPromptCommand(parseSlashCommand('/new fix the build'))).toBe(true)
    expect(isNewPromptCommand(parseSlashCommand('/new'))).toBe(false)
    expect(isNewPromptCommand(parseSlashCommand('/new   '))).toBe(false)
    expect(isNewPromptCommand(parseSlashCommand('/new \t  '))).toBe(false)
    expect(isNewPromptCommand(parseSlashCommand('/new    two  spaces'))).toBe(true)
  })

  it('is false for other commands and for plain text', () => {
    expect(isNewPromptCommand(parseSlashCommand('/btw hello'))).toBe(false)
    expect(isNewPromptCommand(parseSlashCommand('new thing'))).toBe(false)
  })
})

describe('isNewConversationCommand', () => {
  it('covers bare /new and /new <prompt>, so both reset scroll memory', () => {
    expect(isNewConversationCommand(parseSlashCommand('/new'))).toBe(true)
    expect(isNewConversationCommand(parseSlashCommand('/new hello'))).toBe(true)
    expect(isNewConversationCommand(parseSlashCommand('/pause'))).toBe(false)
    expect(isNewConversationCommand(undefined)).toBe(false)
  })
})

describe('slashAttachmentRefusal', () => {
  it('refuses /new <prompt> with a pending image, using the existing slash-command wording', () => {
    expect(slashAttachmentRefusal(parseSlashCommand('/new hello'), withImage)).toBe(SLASH_FILES_REFUSAL)
    expect(SLASH_FILES_REFUSAL).toBe("Slash commands can't carry attached files. Remove them and try again.")
  })

  it('refuses any slash command with a pending file', () => {
    expect(slashAttachmentRefusal(parseSlashCommand('/new hello'), withFile)).toBe(SLASH_FILES_REFUSAL)
    expect(slashAttachmentRefusal(parseSlashCommand('/usage'), withFile)).toBe(SLASH_FILES_REFUSAL)
  })

  it('lets other slash commands keep carrying images, as before', () => {
    expect(slashAttachmentRefusal(parseSlashCommand('/usage'), withImage)).toBeUndefined()
    expect(slashAttachmentRefusal(parseSlashCommand('/new'), withImage)).toBeUndefined()
  })

  it('allows /new <prompt> with no attachments and ignores ordinary text', () => {
    expect(slashAttachmentRefusal(parseSlashCommand('/new hello'), none)).toBeUndefined()
    expect(slashAttachmentRefusal(undefined, withFile)).toBeUndefined()
  })
})

describe('promptWithoutNewCommand', () => {
  it('drops /new so a retry sends only the message', () => {
    expect(promptWithoutNewCommand('/new  fix the build\nthen test')).toBe('fix the build\nthen test')
  })

  it('keeps the draft when it is not a slash command', () => {
    expect(promptWithoutNewCommand('plain')).toBe('plain')
  })

  it('drops runs of spaces and tabs after /new', () => {
    expect(promptWithoutNewCommand('/new \t  fix it')).toBe('fix it')
  })
})

describe('sendRefusal', () => {
  it('refuses a slash command as the /new prompt, however many spaces separate them', () => {
    expect(sendRefusal(parseSlashCommand('/new /compact'), none)).toBe(SLASH_PROMPT_REFUSAL)
    expect(sendRefusal(parseSlashCommand('/new    /compact now'), none)).toBe(SLASH_PROMPT_REFUSAL)
    expect(sendRefusal(parseSlashCommand('/new /new hello'), none)).toBe(SLASH_PROMPT_REFUSAL)
  })

  it('mirrors the wording chat.send refuses with', () => {
    expect(SLASH_PROMPT_REFUSAL).toBe("A slash command can't be the first message of /new. Send the command on its own after /new.")
  })

  it('lets a slash later in the prompt through, and leaves other commands alone', () => {
    expect(sendRefusal(parseSlashCommand('/new see src/main.rs'), none)).toBeUndefined()
    expect(sendRefusal(parseSlashCommand('/btw /compact'), none)).toBeUndefined()
    expect(sendRefusal(parseSlashCommand('/new'), none)).toBeUndefined()
  })

  it('falls back to the attachment refusal when the prompt itself is fine', () => {
    expect(sendRefusal(parseSlashCommand('/new hello'), withImage)).toBe(SLASH_FILES_REFUSAL)
    expect(sendRefusal(parseSlashCommand('/new hello'), withFile)).toBe(SLASH_FILES_REFUSAL)
    expect(sendRefusal(parseSlashCommand('/usage'), withFile)).toBe(SLASH_FILES_REFUSAL)
    expect(sendRefusal(parseSlashCommand('/usage'), withImage)).toBeUndefined()
    expect(sendRefusal(undefined, withFile)).toBeUndefined()
  })

  it('puts the slash-prompt refusal first when both apply', () => {
    expect(sendRefusal(parseSlashCommand('/new /compact'), withImage)).toBe(SLASH_PROMPT_REFUSAL)
  })
})

describe('draftUnchangedSinceSend', () => {
  const attachments = { images: [], files: [] }

  it('is true only while text and attachments are the very ones the send captured', () => {
    expect(draftUnchangedSinceSend({ text: '/new hi', attachments }, { text: '/new hi', attachments })).toBe(true)
    expect(draftUnchangedSinceSend({ text: '/new hi!', attachments }, { text: '/new hi', attachments })).toBe(false)
    expect(draftUnchangedSinceSend({ text: '/new hi', attachments: { images: [], files: [] } }, { text: '/new hi', attachments })).toBe(false)
    expect(draftUnchangedSinceSend(undefined, { text: '/new hi', attachments })).toBe(false)
  })
})

describe('sendFailureRecovery', () => {
  const base = { newConversation: true, draftText: '/new  fix the build', draftUnchanged: true }

  it('puts the bare prompt back after the new Conversation started but the send failed (FR-209)', () => {
    expect(sendFailureRecovery({ ...base, code: NEW_PROMPT_SEND_FAILED })).toEqual({ kind: 'restore-prompt', text: 'fix the build' })
  })

  it('leaves a draft the developer edited during the send alone, and restores no scroll for the lost Conversation', () => {
    expect(sendFailureRecovery({ ...base, code: NEW_PROMPT_SEND_FAILED, draftUnchanged: false })).toEqual({ kind: 'none' })
  })

  it('restores scroll when a /new fails and the old Conversation is still there', () => {
    expect(sendFailureRecovery({ ...base, code: 'not-idle' })).toEqual({ kind: 'restore-scroll' })
    expect(sendFailureRecovery({ ...base, code: 'not-idle', draftUnchanged: false })).toEqual({ kind: 'restore-scroll' })
  })

  it('does nothing for a failed send that was not a /new', () => {
    expect(sendFailureRecovery({ ...base, code: 'not-idle', newConversation: false })).toEqual({ kind: 'none' })
  })
})
