// An agent's result text rendered through the shared sanitised Markdown (#2242), cut to the card's line limit.
// The renderer is never forked: this only picks the options a card needs (embedded code, inert links in a summary).
import * as React from 'react'
import { cn } from '@/lib/utils'
import { Markdown } from '../../chat/Markdown'

export type ResultLines = 1 | 2 | 'all'

// The clamp goes on the paragraph, not the wrapper: `line-clamp` on a block container with block children does not clip.
const CLAMP_CLASS: Record<ResultLines, string | undefined> = {
  1: '[&_p]:truncate',
  2: '[&_p]:line-clamp-2',
  all: undefined
}

// A clamped summary has no live link, so its link text reads as plain text: no accent colour or underline promising a click.
// The inert span is the only underlined span Markdown emits, so it is selected by its own classes.
const INERT_LINK_CLASS = '[&_span.underline]:text-inherit [&_span.underline]:no-underline'

interface ResultMarkdownProps {
  text: string
  lines?: ResultLines
  /** True lets links in the text be followed (the full Result section); a clamped summary keeps them inert so no control nests in the card. */
  interactive?: boolean
  className?: string
}

export function ResultMarkdown({ text, lines = 'all', interactive = false, className }: ResultMarkdownProps) {
  const id = React.useId()
  return (
    <Markdown
      id={id}
      text={text}
      inert={!interactive}
      embedded
      className={cn('space-y-1 text-inherit', !interactive && INERT_LINK_CLASS, CLAMP_CLASS[lines], className)}
    />
  )
}
