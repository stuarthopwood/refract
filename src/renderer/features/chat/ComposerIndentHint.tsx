interface ComposerIndentHintProps {
  /** Id of the sr-only description the textarea references through `aria-describedby`. */
  id: string
  tabMovesFocus: boolean
}

/** The visible "Tab moves focus" hint (only while on) and the textarea's spoken description of Tab and Ctrl+M (#1080). */
export function ComposerIndentHint({ id, tabMovesFocus }: ComposerIndentHintProps) {
  return (
    <>
      <span id={id} className="sr-only">
        {tabMovesFocus ? 'Tab moves focus. Press Control+M to indent with Tab instead.' : 'Tab indents. Press Control+M to move focus with Tab instead.'}
      </span>
      {tabMovesFocus && <p className="text-xs text-muted-foreground">Tab moves focus · Ctrl+M to indent</p>}
    </>
  )
}
