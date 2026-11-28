// #525: a read-only, highlighted copy of the draft's last fenced block, in flow above the field. It is
// not an overlay: the spec 050 mirror stays the only layer over the textarea.
import { useDeferredValue, useMemo, useState } from 'react'
import { COMPOSER_PANEL_MAX_HEIGHT_CLASS } from '@/components/ComposerPanel'
import { FadeCollapse } from '@/components/FadeCollapse'
import { languageLabel } from '@/lib/codeFenceLanguages'
import { describeSnippetAnnouncement, findPreviewBlock, type PreviewBlock } from '@/lib/codeSnippetFence'
import { CodeBlock } from './CodeBlock'

export const PREVIEW_MAX_LINES = 12

/** The block cut to the preview's line cap, with how many lines it hides. */
export function capPreviewBlock(block: PreviewBlock): { code: string; hidden: number } {
  if (block.lineCount <= PREVIEW_MAX_LINES) return { code: block.body, hidden: 0 }
  return { code: block.body.split('\n').slice(0, PREVIEW_MAX_LINES).join('\n'), hidden: block.lineCount - PREVIEW_MAX_LINES }
}

export function ComposerCodePreview({ text, enabled }: { text: string; enabled: boolean }) {
  // Highlighting stays off the keystroke path: the strip follows a deferred copy of the draft.
  const deferred = useDeferredValue(text)
  const block = useMemo(() => (enabled ? findPreviewBlock(deferred) : null), [enabled, deferred])
  // Announced when the preview appears, goes or changes language, not for every typed line.
  const key = block ? (languageLabel(block.tag) ?? 'text') : null
  const [announced, setAnnounced] = useState<{ key: string | null; text: string }>({ key: null, text: '' })
  if (announced.key !== key) setAnnounced({ key, text: block ? describeSnippetAnnouncement(block) : '' })
  const capped = block ? capPreviewBlock(block) : null

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        {announced.text}
      </p>
      <FadeCollapse show={capped !== null} className="px-1">
        {capped && block && (
          <div aria-hidden="true" inert>
            <div className={`${COMPOSER_PANEL_MAX_HEIGHT_CLASS} overflow-hidden`}>
              <CodeBlock code={capped.code} lang={block.tag} embedded streaming />
            </div>
            {capped.hidden > 0 && (
              <p className="px-2 pt-1 text-xs text-muted-foreground">
                {capped.hidden} more {capped.hidden === 1 ? 'line' : 'lines'}
              </p>
            )}
          </div>
        )}
      </FadeCollapse>
    </>
  )
}
