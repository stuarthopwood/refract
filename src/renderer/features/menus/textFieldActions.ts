import { toast } from 'sonner'
import { notify } from '@/state'
import type { TextEditAction } from '@/features/palette/menuItems'

export type TextField = HTMLInputElement | HTMLTextAreaElement

// IPC for both directions: the webview's Clipboard API can raise a permission prompt or resolve without reaching the OS clipboard.
async function writeClipboard(text: string): Promise<boolean> {
  const result = await window.refract.clipboard.writeText(text)
  if (!result.ok) notify(result.error)
  return result.ok
}

const MAX_PASTE_CHARS = 1_000_000

function isLiveFocused(field: TextField): boolean {
  return field.isConnected && document.activeElement === field
}

async function readClipboard(): Promise<string | null> {
  const result = await window.refract.clipboard.readText()
  if (!result.ok) {
    notify(result.error)
    return null
  }
  if (result.value.length > MAX_PASTE_CHARS) {
    toast.error('The clipboard text is too large to paste here.')
    return null
  }
  if (result.value === '') {
    toast.info('The clipboard has no text. Use Ctrl+V to paste images or files.')
    return null
  }
  return result.value
}

/** Copies text captured when the menu opened, for read-only text that has no field; empty text is a no-op. */
export async function copySelection(text: string): Promise<void> {
  if (text !== '') await writeClipboard(text)
}

/** Runs a text-edit menu action against a text field, through the IPC clipboard. */
export async function runTextFieldAction(field: TextField, action: TextEditAction, copyText: string): Promise<void> {
  if (!isLiveFocused(field)) return
  const start = field.selectionStart ?? 0
  const end = field.selectionEnd ?? 0
  const value = field.value
  const selected = value.slice(start, end)
  switch (action) {
    case 'select-all':
      field.select()
      return
    case 'copy':
      if (copyText !== '') await writeClipboard(copyText)
      return
    case 'cut':
      // Delete only after a confirmed write, and only if the text and selection did not move meanwhile.
      if (!(await writeClipboard(selected))) return
      if (!isLiveFocused(field) || field.value !== value || field.selectionStart !== start || field.selectionEnd !== end) return
      document.execCommand('delete')
      return
    case 'paste':
    case 'paste-text': {
      const text = await readClipboard()
      if (text == null || !isLiveFocused(field)) return
      // Plain paste replays a paste event so the field's own handler (large-text chip, image
      // paths) runs; "as plain text" inserts the literal text and skips it.
      if (action === 'paste') {
        const data = new DataTransfer()
        data.setData('text/plain', text)
        const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
        if (!field.dispatchEvent(event)) return
      }
      document.execCommand('insertText', false, text)
    }
  }
}
