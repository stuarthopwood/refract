import * as React from 'react'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
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
export function CappedCodeBlock({ code, lang, hideCopy = false }: { code: string; lang: string | null; hideCopy?: boolean }) {
  const [showAll, setShowAll] = React.useState(false)
  const lines = React.useMemo(() => code.split('\n'), [code])
  const truncated = !showAll && lines.length > OUTPUT_LINE_CAP
  const visible = truncated ? lines.slice(0, OUTPUT_LINE_CAP).join('\n') : code
  return (
    <div>
      <CodeBlock
        code={visible}
        lang={lang}
        copyText={code}
        wrap={lang === null}
        hideCopy={hideCopy}
        expandable={truncated ? { expanded: false, onToggle: () => setShowAll(true) } : undefined}
      />
      {truncated && (
        <Button variant="ghost" size="sm" className="mt-1" onClick={() => setShowAll(true)}>
          Show all ({lines.length} lines)
        </Button>
      )}
    </div>
  )
}

function isSectionView(value: string): value is SectionView {
  return value === 'rendered' || value === 'source'
}

// One Copy control per section, in the header, in both views; it always copies the source text,
// and the code block's own Copy is suppressed so it never duplicates this one.
function SectionHeader({ section, children }: { section: Section; children?: React.ReactNode }) {
  return (
    <div className="mb-1 flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{section.label}</span>
      <div className="flex items-center gap-1">
        {section.code !== '' && (
          <CopyButton getText={() => section.code} label={`Copy ${section.label}`} announcement={`${section.label} copied`} />
        )}
        {children}
      </div>
    </div>
  )
}

// Plain-text sections (no highlight language) get a Rendered/Source toggle (#719). Rendered goes
// through the sanitising `Markdown` (no `resolveImage`, so images are never fetched or shown).
// A large value stays on Source until the user opts in with "Render anyway".
function RenderableSection({ section }: { section: Section }) {
  const large = React.useMemo(() => isLargeValue(section.code), [section.code])
  const [view, setView] = React.useState<SectionView>(section.defaultView)
  const [renderAnyway, setRenderAnyway] = React.useState(false)
  const blocked = large && !renderAnyway
  const effectiveView: SectionView = blocked ? 'source' : view
  const noteId = React.useId()
  const renderedRef = React.useRef<HTMLButtonElement>(null)
  const focusRendered = React.useRef(false)
  React.useEffect(() => {
    if (!blocked && focusRendered.current) {
      focusRendered.current = false
      renderedRef.current?.focus()
    }
  }, [blocked])
  return (
    <div>
      <SectionHeader section={section}>
        <ToggleGroup
          type="single"
          value={effectiveView}
          onValueChange={(value) => {
            if (isSectionView(value) && !blocked) setView(value)
          }}
          size="sm"
          aria-label={`${section.label} view`}
        >
          <ToggleGroupItem
            ref={renderedRef}
            value="rendered"
            aria-disabled={blocked || undefined}
            aria-describedby={blocked ? noteId : undefined}
          >
            Rendered
          </ToggleGroupItem>
          <ToggleGroupItem value="source">
            Source
          </ToggleGroupItem>
        </ToggleGroup>
      </SectionHeader>
      {blocked && (
        <p id={noteId} className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          Too large to render.
          <Button
            variant="text"
            size="xs"
            onClick={() => {
              focusRendered.current = true
              setRenderAnyway(true)
              setView('rendered')
            }}
          >
            Render anyway
          </Button>
        </p>
      )}
      {effectiveView === 'source' ? (
        <CappedCodeBlock code={section.code} lang={null} hideCopy />
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
      <SectionHeader section={section} />
      <CappedCodeBlock code={section.code} lang={section.lang} hideCopy />
    </div>
  )
}

