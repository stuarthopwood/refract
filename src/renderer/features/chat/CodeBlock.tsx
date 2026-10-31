import * as React from 'react'
import { WrapTextIcon } from 'lucide-react'
import type { Highlighter } from 'shiki'
import { ContextMenuCheckboxItem } from '@/components/ui/context-menu'
import { DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu'
import { CopyButton } from '@/components/ui/copy-button'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { actionMenuItem, menuSeparator, type MenuKind } from '@/features/palette/menuItems'
import { cn } from '@/lib/utils'
import { useSyntaxTheme } from '@/state'
import { copyLinkText } from './linkClipboard'
import { getHighlighter, highlightToHtml } from './shikiHighlighter'
import { TranscriptKebab, TranscriptMenu } from './TranscriptMenu'

interface CodeBlockHeaderProps {
  label: string
  copyText: string
  hideCopy: boolean
  /** Null hides the Wrap control (a caller with its own, or a streaming block). */
  wrap: { on: boolean; onChange: (on: boolean) => void } | null
  /** The menu's items, shown by the trailing kebab; null hides it. */
  items: ((kind: MenuKind) => React.ReactNode) | null
}

// Header above every code block: the language when known and highlighted, else "text", so it never
// claims a highlight the body lacks. `copyText` is the full value to copy (a caller may show a
// truncated body, #524); the Copy button is always visible, hidden when empty so it never clears
// the clipboard, and its label names the language so blocks are distinguishable to a screen reader.
function CodeBlockHeader({ label, copyText, hideCopy, wrap, items }: CodeBlockHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border bg-code-block px-2 py-1 font-code text-xs text-muted-foreground">
      <span className="truncate text-md-code-label">{label}</span>
      <div className="flex items-center gap-1">
        {wrap && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Toggle
                variant="subtle"
                size="icon-xs"
                pressed={wrap.on}
                onPressedChange={wrap.onChange}
                aria-label={`Wrap lines, ${label}`}
                className="-my-1 text-muted-foreground focus-visible:outline-offset-[-2px]"
              >
                <WrapTextIcon aria-hidden />
              </Toggle>
            </TooltipTrigger>
            <TooltipContent>Wrap lines</TooltipContent>
          </Tooltip>
        )}
        {copyText !== '' && !hideCopy && (
          <CopyButton
            getText={() => copyText}
            label={`Copy code, ${label}`}
            announcement="Code copied"
            className="-my-1 text-muted-foreground focus-visible:ring-inset"
          />
        )}
        {items && <TranscriptKebab lazy items={items} label={`More actions, ${label}`} className="-my-1" />}
      </div>
    </div>
  )
}

// Above this size `CodeBlock` skips Shiki: its synchronous `codeToHtml` froze the renderer (#671).
const MAX_HIGHLIGHT_BYTES = 200 * 1024

export interface CodeBlockProps {
  code: string
  lang: string | null
  // Wrap for prose-shaped surfaces; other callers (fences, tool output, ASCII diagrams) scroll sideways.
  // It is only the starting state: the block's own Wrap toggle owns it afterwards and never persists it.
  wrap?: boolean
  // Opt-in line-number gutter, one row per source line for both highlighted and plain paths. It is
  // not rendered while wrap is on, since wrapped lines would misalign the numbers.
  lineNumbers?: boolean
  // What Copy puts on the clipboard when it differs from the visible `code` (#524); defaults to `code`.
  copyText?: string
  // True when the caller owns a single Copy control elsewhere (the tool dialog's section header).
  hideCopy?: boolean
  // True when the caller already offers its own Wrap control (the file preview).
  hideWrap?: boolean
  // A streaming block has no menu, Copy or Wrap: its text is still changing.
  streaming?: boolean
  // Set by a caller that collapses the block (the 200-line cap); adds Expand/Collapse to the menu.
  expandable?: { expanded: boolean; onToggle: () => void }
}

/** The shared code-block renderer; every block's header carries Copy and Wrap controls and a context menu (#524, #471). */
export function CodeBlock({
  code,
  lang,
  wrap = false,
  lineNumbers = false,
  copyText,
  hideCopy = false,
  hideWrap = false,
  streaming = false,
  expandable
}: CodeBlockProps) {
  const syntaxTheme = useSyntaxTheme()
  const [html, setHtml] = React.useState<string | null>(null)
  const [wrapOn, setWrapOn] = React.useState(wrap)
  React.useEffect(() => setWrapOn(wrap), [wrap])

  React.useEffect(() => {
    setHtml(null)
    // `codeToHtml` is synchronous (2.1 MB took 10.7s, freezing the whole renderer), so oversized
    // code takes the instant plain-<pre> fallback instead.
    if (!lang || code.length > MAX_HIGHLIGHT_BYTES) return
    let cancelled = false
    void (async () => {
      try {
        const highlighter = await getHighlighter()
        if (!highlighter.getLoadedLanguages().includes(lang)) {
          // `lang` comes from agent-authored fence info, not a validated list; shiki throws for
          // an unknown name and the catch below falls back to the plain <pre><code>.
          await highlighter.loadLanguage(lang as Parameters<Highlighter['loadLanguage']>[0])
        }
        if (cancelled) return
        // #975/#456: the body shares `bg-code-block` with the header/gutter; `highlightToHtml` neutralises Shiki's own root background.
        setHtml(highlightToHtml(highlighter, code, lang, syntaxTheme))
      } catch {
        if (!cancelled) setHtml(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, lang, syntaxTheme])

  const label = html ? lang! : 'text'
  const fullText = copyText ?? code
  // Named and keyboard-reachable so a wide block is its own scrollable region.
  const regionLabel = `${label} code block`
  // `ring-inset` keeps the ring inside the box, where the wrapper's `overflow-hidden` can't clip it.
  const scrollableClassName = 'overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'
  // Applies regardless of `lang`/`html`: wrap works for highlighted and plain blocks alike.
  const wrapClassName = 'whitespace-pre-wrap break-words outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'
  const showLineNumbers = lineNumbers && !wrapOn
  const lineCount = showLineNumbers ? code.split('\n').length : 0

  // One text node, not a <div> per line (a ~1 MiB file would allocate 30-60k nodes); the leading
  // matches the content column so numbers line up.
  const gutter = showLineNumbers ? (
    <pre
      aria-hidden
      className="m-0 select-none border-r border-border bg-code-block py-4 pl-4 pr-2 text-right leading-[1.6] text-muted-foreground tabular-nums"
    >
      {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
    </pre>
  ) : null

  const body = html ? (
    // Shiki's own output (highlighted spans only; no agent text interpreted as markup).
    <div
      tabIndex={0}
      role="region"
      aria-label={regionLabel}
      className={cn(
        'min-w-0 flex-1 bg-code-block',
        wrapOn ? wrapClassName : scrollableClassName,
        wrapOn ? '[&>pre]:m-0 [&>pre]:p-4 [&>pre]:whitespace-pre-wrap [&>pre]:break-words' : '[&>pre]:m-0 [&>pre]:p-4 [&>pre]:leading-[1.6]'
      )}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : (
    <pre
      tabIndex={0}
      role="region"
      aria-label={regionLabel}
      className={cn('min-w-0 flex-1', wrapOn ? wrapClassName : scrollableClassName, 'bg-code-block p-4 leading-[1.6]')}
    >
      <code>{code}</code>
    </pre>
  )

  const menuDisabled = streaming || (fullText === '' && hideWrap && !expandable)
  const items = (kind: MenuKind) => {
    const WrapItem = kind === 'dropdown' ? DropdownMenuCheckboxItem : ContextMenuCheckboxItem
    return (
      <>
        {fullText !== '' && actionMenuItem('transcript.copy-code', { kind, onSelect: () => void copyLinkText(fullText, 'Code copied', 'Nothing to copy: this block only contains hidden characters') })}
        {fullText !== '' && (!hideWrap || expandable) && menuSeparator(kind)}
        {!hideWrap && (
          <WrapItem icon={WrapTextIcon} checked={wrapOn} onCheckedChange={setWrapOn}>
            Wrap lines
          </WrapItem>
        )}
        {expandable && actionMenuItem(expandable.expanded ? 'transcript.collapse' : 'transcript.expand', { kind, onSelect: expandable.onToggle })}
      </>
    )
  }

  return (
    <TranscriptMenu disabled={menuDisabled} className="not-prose max-w-none overflow-hidden rounded-lg border border-border text-xs" items={items}>
      <CodeBlockHeader
        label={label}
        copyText={fullText}
        hideCopy={hideCopy || streaming}
        wrap={hideWrap || streaming ? null : { on: wrapOn, onChange: setWrapOn }}
        items={menuDisabled ? null : items}
      />
      <div className="flex">
        {gutter}
        {body}
      </div>
    </TranscriptMenu>
  )
}
