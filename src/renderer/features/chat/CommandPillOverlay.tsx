// With no recognised token this renders nothing and the textarea keeps its opaque rendering.
import type { ReactNode, RefObject } from 'react'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { classifySlashInvocation, parseSlashCommand } from '../../../shared/slash-commands'
import type { SlashCommand } from '../../../shared/ipc'
import { COMPOSER_MIRROR_CLASS } from '@/components/ComposerBox'
import { ComposerMarkdownMirror, COMPOSER_MARKDOWN_TEXTAREA_CLASS, useComposerMarkdownSegments } from './composerMarkdownMirror'
import type { MdSegment } from '@/lib/markdownLineTokens'

/** The character range of a recognised leading command/skill token in `text`, or `undefined` when the draft does not start with one. */
export interface RecognisedCommandToken {
  start: number
  end: number
}

export function findRecognisedCommandToken(text: string, commands: readonly SlashCommand[]): RecognisedCommandToken | undefined {
  const parsed = parseSlashCommand(text)
  if (!parsed) return undefined
  if (classifySlashInvocation(parsed, commands) === 'unknown-command') return undefined
  // `parseSlashCommand` itself trims LEADING whitespace before parsing (decision 1: "the very start
  // of the draft"): the token's own real character offsets in the untrimmed `text` start after
  // however much of that leading whitespace exists, never assumed to be a bare 0.
  const start = text.length - text.trimStart().length
  return { start, end: start + 1 + parsed.name.length }
}

/** Shared box-model-matching classes for every inert composer mirror (the ghost-text overlay, the pending-text-chip overlay, and this pill) -- one constant instead of three verbatim copies, so a future padding/font change can never silently drift one mirror out of alignment with the others. */
export { COMPOSER_MIRROR_CLASS }

const PILL_CLASS = 'rounded-sm bg-command-pill-bg text-command-pill-fg shadow-[-2px_0_0_2px_var(--command-pill-bg),2px_0_0_2px_var(--command-pill-bg)] [box-decoration-break:clone]'

/** `-webkit-text-fill-color` masks ONLY the glyph fill; `color` stays whatever it would ordinarily resolve to (a real, visible value), so anything that reads `color` rather than the fill (composition underlines, any future `currentColor` decoration) keeps rendering correctly. */
export const COMMAND_PILL_TEXTAREA_CLASS =
  'relative z-[1] [-webkit-text-fill-color:transparent] forced-colors:[-webkit-text-fill-color:CanvasText] caret-foreground'

// Belt-and-braces for the same WebView2 gap the base masking rule above already works around:
// `-webkit-text-fill-color` cannot be relied on to track `color` through a `::selection` override
// in every engine, so both are set explicitly rather than assuming one implies the other.
/** `null` when there is no recognised token (the caller never even mounts this, but the guard keeps the component safe to call unconditionally too). */
export function CommandPillOverlay({
  text,
  token,
  overlayRef,
  markdownSegments
}: {
  text: string
  token: RecognisedCommandToken | undefined
  overlayRef: RefObject<HTMLDivElement | null>
  // #1170: live Markdown styling for a non-command draft (null or absent: nothing to style).
  markdownSegments?: MdSegment[] | null
}): ReactNode {
  if (!token) return markdownSegments ? <ComposerMarkdownMirror segments={markdownSegments} text={text} mirrorRef={overlayRef} /> : null
  const before = text.slice(0, token.start)
  const pillText = text.slice(token.start, token.end)
  const afterRaw = text.slice(token.end)
  const after = afterRaw.endsWith('\n') ? afterRaw + '\u200b' : afterRaw
  return (
    <div ref={overlayRef} aria-hidden="true" data-command-pill-overlay className={COMPOSER_MIRROR_CLASS}>
      {before}
      <span data-command-pill-token className={PILL_CLASS}>
        {pillText}
      </span>
      {after}
    </div>
  )
}

/** `MessageInput.tsx`'s own integration point (working rule 11, file-size cap: that file has no room for the ref/memo/scroll-sync wiring this needs, only the hook call plus `<CommandPillOverlay.../>` at the render call-site). */
export function useCommandPillOverlay(text: string, commands: readonly SlashCommand[], textareaRef: RefObject<HTMLTextAreaElement | null>) {
  const commandToken = useMemo(() => findRecognisedCommandToken(text, commands), [text, commands])
  const commandPillOverlayRef = useRef<HTMLDivElement>(null)
  // #1170: the same mirror slot draws Markdown styling when no command pill is showing.
  const markdownSegments = useComposerMarkdownSegments(text, !commandToken)
  useLayoutEffect(() => {
    if ((commandToken || markdownSegments) && commandPillOverlayRef.current && textareaRef.current) {
      commandPillOverlayRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [commandToken, markdownSegments, text, textareaRef])
  const textareaClass = commandToken ? COMMAND_PILL_TEXTAREA_CLASS : markdownSegments ? COMPOSER_MARKDOWN_TEXTAREA_CLASS : undefined
  return { commandToken, commandPillOverlayRef, markdownSegments, textareaClass }
}
