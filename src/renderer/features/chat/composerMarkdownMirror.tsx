import type { ReactNode, RefObject } from 'react'
import { useMemo } from 'react'
import { COMPOSER_MIRROR_CLASS } from '@/components/ComposerBox'
import { tokenizeMarkdownDraft, type MdKind, type MdSegment } from '@/lib/markdownLineTokens'
import { cn } from '@/lib/utils'

const STROKE = '[-webkit-text-stroke:0.6px_currentColor]'

const KIND_CLASS: Record<MdKind, string | undefined> = {
  plain: undefined,
  marker: 'text-muted-foreground',
  heading: STROKE,
  quote: 'text-muted-foreground',
  listMarker: 'text-accent-text',
  bold: STROKE,
  italic: 'text-accent-text',
  code: 'text-accent-text'
}

/**
 * Added to the textarea while the mirror is drawing: masks the glyph fill (the mirror shows
 * through), keeps the native caret, and restores plain fill in Dark (high contrast).
 */
export const COMPOSER_MARKDOWN_TEXTAREA_CLASS =
  'relative z-[1] [-webkit-text-fill-color:transparent] caret-foreground forced-colors:[-webkit-text-fill-color:CanvasText] [.theme-dark-high-contrast_&]:[-webkit-text-fill-color:var(--foreground)]'

const MIRROR_HIDDEN_CLASS = 'forced-colors:hidden [.theme-dark-high-contrast_&]:hidden'

/** A draft starting with `/` is a slash command; the command pill owns that case. */
export function composerMarkdownSegments(text: string, enabled: boolean): MdSegment[] | null {
  if (!enabled || text.trimStart().startsWith('/')) return null
  return tokenizeMarkdownDraft(text)
}

export function ComposerMarkdownMirror({
  segments,
  text,
  mirrorRef,
  className
}: {
  segments: MdSegment[]
  text: string
  mirrorRef: RefObject<HTMLDivElement | null>
  className?: string
}): ReactNode {
  return (
    <div ref={mirrorRef} aria-hidden="true" data-composer-markdown-mirror className={cn(COMPOSER_MIRROR_CLASS, MIRROR_HIDDEN_CLASS, className)}>
      {segments.map((seg, index) => (
        <span key={index} data-md={seg.kind} className={cn('[font-weight:inherit]', KIND_CLASS[seg.kind])}>
          {seg.text}
        </span>
      ))}
      {text.endsWith('\n') ? '\u200b' : null}
    </div>
  )
}

export function useComposerMarkdownSegments(text: string, enabled: boolean): MdSegment[] | null {
  return useMemo(() => composerMarkdownSegments(text, enabled), [text, enabled])
}
