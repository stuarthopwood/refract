import { Kbd, KbdGroup } from '@/components/ui/kbd'

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
        {tabMovesFocus ? 'Tab moves focus. Press Control+M to make Tab indent instead.' : 'Tab indents. Press Control+M to make Tab move focus instead.'}
      </span>
      {tabMovesFocus && (
        <p className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <Kbd>Tab</Kbd> moves focus
          <KbdGroup>
            <Kbd>Ctrl</Kbd>
            <Kbd>M</Kbd>
          </KbdGroup>
          to switch
        </p>
      )}
    </>
  )
}
