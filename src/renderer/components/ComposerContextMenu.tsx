import { useRef, useState, type ReactNode } from 'react'
import { notify } from '@/state'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'

type FieldAction = 'cut' | 'copy' | 'paste' | 'paste-text' | 'select-all'

interface FieldState {
  hasSelection: boolean
  editable: boolean
  hasText: boolean
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // The sandboxed webview can refuse the Clipboard API; main's channel needs no permission.
  }
  const result = await window.refract.clipboard.writeText(text)
  if (!result.ok) notify(result.error)
}

// IPC only: the webview's own readText can raise a permission prompt.
async function readClipboard(): Promise<string | null> {
  const result = await window.refract.clipboard.readText()
  if (!result.ok) {
    notify(result.error)
    return null
  }
  if (result.value === '') {
    notify({ code: 'clipboard-failed', message: 'The clipboard has no text' })
    return null
  }
  return result.value
}

async function runAction(field: HTMLTextAreaElement, action: FieldAction): Promise<void> {
  const selected = field.value.slice(field.selectionStart, field.selectionEnd)
  switch (action) {
    case 'select-all':
      field.select()
      return
    case 'copy':
      await writeClipboard(selected)
      return
    case 'cut':
      await writeClipboard(selected)
      document.execCommand('delete')
      return
    case 'paste':
    case 'paste-text': {
      const text = await readClipboard()
      if (text == null) return
      // Plain paste replays a paste event so the composer's own handler (large-text chip, image
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

/** Right-click / Shift+F10 / Menu key menu for a composer text field (#471): Cut, Copy, Paste,
 * Paste as plain text, Select all. Wraps the textarea without changing its layout. */
export function ComposerContextMenu({ children }: { children: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef<FieldAction | null>(null)
  const [state, setState] = useState<FieldState>({ hasSelection: false, editable: false, hasText: false })

  const field = () => boxRef.current?.querySelector('textarea') ?? null

  return (
    <ContextMenu
      onOpenChange={(open) => {
        const el = field()
        if (!open || !el) return
        setState({ hasSelection: el.selectionStart !== el.selectionEnd, editable: !el.readOnly && !el.disabled, hasText: el.value !== '' })
      }}
    >
      <ContextMenuTrigger asChild>
        <div ref={boxRef} className="contents select-text">
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const el = field()
          const action = pendingRef.current
          pendingRef.current = null
          el?.focus()
          if (el && action) void runAction(el, action)
        }}
      >
        <ContextMenuItem disabled={!state.editable || !state.hasSelection} onSelect={() => (pendingRef.current = 'cut')}>
          Cut
        </ContextMenuItem>
        <ContextMenuItem disabled={!state.hasSelection} onSelect={() => (pendingRef.current = 'copy')}>
          Copy
        </ContextMenuItem>
        <ContextMenuItem disabled={!state.editable} onSelect={() => (pendingRef.current = 'paste')}>
          Paste
        </ContextMenuItem>
        <ContextMenuItem disabled={!state.editable} onSelect={() => (pendingRef.current = 'paste-text')}>
          Paste as plain text
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!state.hasText} onSelect={() => (pendingRef.current = 'select-all')}>
          Select all
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
