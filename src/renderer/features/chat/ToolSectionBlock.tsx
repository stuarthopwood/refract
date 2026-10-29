import * as React from 'react'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { SELECTED_SEGMENT_CLASS, ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { CodeBlock, Markdown } from './Markdown'
import { isLargeValue, type SectionView } from './toolViewRules'

export interface Section {
  label: string
  lang: string | null
  code: string
  defaultView: SectionView
}

// Same cap `ToolCallBody` applied to its own Arguments/Output blocks before #628 moved them here
// (T083, WCAG 1.4.10): a 200-line value still needs its own "Show all" opt-in even inside the
// dialog's own scrolling region, so one huge argument or output can never make the dialog itself
// unusably long to scroll past.
const OUTPUT_LINE_CAP = 200

// A value capped at `OUTPUT_LINE_CAP` visible lines with its own "Show all" opt-in (T083, WCAG
// 1.4.10, kept from `ToolCallBody`'s pre-#628 Output/write-content blocks); Copy always copies
// the full, untruncated text regardless of how much is currently visible (#524).
export function CappedCodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const [showAll, setShowAll] = React.useState(false)
  const lines = React.useMemo(() => code.split('\n'), [code])
  const truncated = !showAll && lines.length > OUTPUT_LINE_CAP
  const visible = truncated ? lines.slice(0, OUTPUT_LINE_CAP).join('\n') : code
  return (
    <div>
      <CodeBlock code={visible} lang={lang} copyText={code} wrap={lang === null} />
      {truncated && (
        <Button variant="ghost" size="sm" className="mt-1" onClick={() => setShowAll(true)}>
          Show all ({lines.length} lines)
        </Button>
      )}
    </div>
  )
}

// Plain-text sections (no highlight language) get a Rendered/Source toggle (#719). Rendered goes
// through the sanitising `Markdown` (no `resolveImage`, so images are never fetched or shown);
// Copy always copies the source text in both views.
function RenderableSection({ section }: { section: Section }) {
  const large = React.useMemo(() => isLargeValue(section.code), [section.code])
  const [view, setView] = React.useState<SectionView>(large ? 'source' : section.defaultView)
  const [renderAnyway, setRenderAnyway] = React.useState(false)
  const showRendered = view === 'rendered'
  const blocked = showRendered && large && !renderAnyway
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{section.label}</span>
        <div className="flex items-center gap-1">
          {showRendered && !blocked && (
            <CopyButton getText={() => section.code} label={`Copy ${section.label} source`} announcement="Source copied" />
          )}
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(value) => {
              if (value) setView(value as SectionView)
            }}
            variant="outline"
            size="sm"
            spacing={0}
            aria-label={`${section.label} view`}
          >
            <ToggleGroupItem value="rendered" className={SELECTED_SEGMENT_CLASS}>
              Rendered
            </ToggleGroupItem>
            <ToggleGroupItem value="source" className={SELECTED_SEGMENT_CLASS}>
              Source
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      {!showRendered || blocked ? (
        <>
          <CappedCodeBlock code={section.code} lang={null} />
          {blocked && (
            <Button variant="outline" size="sm" className="mt-1" onClick={() => setRenderAnyway(true)}>
              Render anyway
            </Button>
          )}
        </>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border p-2">
          <Markdown text={section.code} id={`tool-dialog-${section.label}`} />
        </div>
      )}
    </div>
  )
}

export function SectionBlock({ section }: { section: Section }) {
  if (section.lang === null) return <RenderableSection section={section} />
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{section.label}</div>
      <CappedCodeBlock code={section.code} lang={section.lang} />
    </div>
  )
}
