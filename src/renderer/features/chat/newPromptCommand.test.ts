// `/new <prompt>` composer rules (#1827, FR-208 to FR-210).
import { describe, expect, it } from 'vitest'
import { parseSlashCommand } from '../../../shared/slash-commands'
import {
  isNewConversationCommand,
  isNewPromptCommand,
  promptWithoutNewCommand,
  slashAttachmentRefusal,
  SLASH_FILES_REFUSAL
} from './newPromptCommand'

const none = { images: [], files: [] }
const withImage = { images: [{}], files: [] }
const withFile = { images: [], files: [{}] }

describe('isNewPromptCommand', () => {
  it('is true for /new with a message and false for bare /new', () => {
    expect(isNewPromptCommand(parseSlashCommand('/new fix the build'))).toBe(true)
    expect(isNewPromptCommand(parseSlashCommand('/new'))).toBe(false)
    expect(isNewPromptCommand(parseSlashCommand('/new   '))).toBe(false)
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
})
