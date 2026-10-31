import { useCallback, useState, type KeyboardEvent, type RefObject } from 'react'
import { applyEdit, planIndent, planListContinuation } from './composerIndent'

/** Tab indent, Ctrl+M "Tab moves focus" (WCAG 2.1.2) and Shift+Enter list continuation for the composer (#1080). */
export function useComposerIndent(textareaRef: RefObject<HTMLTextAreaElement | null>, announce: (message: string) => void) {
  const [tabMovesFocus, setTabMovesFocus] = useState(false)

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      const textarea = textareaRef.current
      if (!textarea || event.nativeEvent.isComposing) return false
      if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault()
        setTabMovesFocus(!tabMovesFocus)
        announce(tabMovesFocus ? 'Tab indents' : 'Tab moves focus')
        return true
      }
      if (event.ctrlKey || event.altKey || event.metaKey) return false
      const { value, selectionStart, selectionEnd } = textarea
      const indenting = event.key === 'Tab' && !tabMovesFocus
      const edit = indenting
        ? planIndent(value, selectionStart, selectionEnd, event.shiftKey)
        : event.key === 'Enter' && event.shiftKey
          ? planListContinuation(value, selectionStart, selectionEnd)
          : null
      if (!indenting && !edit) return false
      event.preventDefault()
      if (edit) applyEdit(textarea, edit)
      return true
    },
    [textareaRef, announce, tabMovesFocus]
  )

  return { tabMovesFocus, handleKeyDown, resetFocusMode: useCallback(() => setTabMovesFocus(false), []) }
}
