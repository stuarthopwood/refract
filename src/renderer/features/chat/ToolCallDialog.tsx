import * as React from 'react'
import type { TranscriptItem } from '../../../shared/model'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CodeBlock, inferOutputBlock, mutedLinkClassName } from './Markdown'
import { formatDuration, StatusIcon, toolStatusLabel } from './ToolRow'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

// Same cap `ToolCallBody` applied to its own Arguments/Output blocks before #628 moved them here
// (T083, WCAG 1.4.10): a 200-line value still needs its own "Show all" opt-in even inside the
// dialog's own scrolling region, so one huge argument or output can never make the dialog itself
// unusably long to scroll past.
const OUTPUT_LINE_CAP = 200

interface Section {
  label: string
  lang: string | null
  code: string
}

// Each key of a tool call's own `args` becomes its own labelled section (#628 Formatted tab):
// a string value is shown exactly as written, as plain text with real line breaks (a `bash`
// call's own `command` highlighted as `bash` instead, matching the pre-#628 special case) --
// never reparsed or re-escaped, unlike the JSON tab's single, faithful `JSON.stringify`. A
// non-string value (number, boolean, object, array, null) has no "real line breaks" of its own,
// so it is pretty-printed as JSON instead.
function argumentSections(item: ToolItem): Section[] {
  if (item.args && typeof item.args === 'object' && !Array.isArray(item.args)) {
    const entries = Object.entries(item.args as Record<string, unknown>)
    if (entries.length > 0) {
      return entries.map(([key, value]) => {
        if (typeof value === 'string') {
          const lang = item.tool === 'bash' && key === 'command' ? 'bash' : null
          return { label: key, lang, code: value }
        }
        return { label: key, lang: 'json', code: JSON.stringify(value, null, 2) }
      })
    }
  }
  return [{ label: 'Arguments', lang: 'json', code: JSON.stringify(item.args ?? null, null, 2) }]
}

// A value capped at `OUTPUT_LINE_CAP` visible lines with its own "Show all" opt-in (T083, WCAG
// 1.4.10, kept from `ToolCallBody`'s pre-#628 Output/write-content blocks); Copy always copies
// the full, untruncated text regardless of how much is currently visible (#524).
function CappedCodeBlock({ code, lang }: { code: string; lang: string | null }) {
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

function SectionBlock({ section }: { section: Section }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{section.label}</div>
      <CappedCodeBlock code={section.code} lang={section.lang} />
    </div>
  )
}

export interface ToolCallDialogProps {
  item: ToolItem
}

// The "View full call" link and its dialog (#628, #630): reuses `TextPreviewModal.tsx`'s own
// Radix dialog pattern (focus returns to the trigger on Esc/outside click by Radix's own
// default, since the trigger here is always a real, always-mounted button). A text link, never
// a button (the issue's own wording) -- same underline-only, row-muted style `FileLinkButton`
// uses on a `bg-muted` surface, since this sits in the row's own muted expansion content, not on
// an accent-coloured surface. Two tabs: Formatted (default, the readable view -- a small header,
// each argument as its own section, then Output) and JSON (the exact arguments and output,
// pretty-printed in one code block, the faithful record for a bug report). Never markdown
// (constitution V): every value is inert text or `CodeBlock`-highlighted code, nothing here is
// ever parsed as markup.
export function ToolCallDialog({ item }: ToolCallDialogProps) {
  const sections = React.useMemo(() => argumentSections(item), [item])
  const outputBlock = React.useMemo(() => (item.output != null ? inferOutputBlock(item.output) : null), [item.output])
  const jsonText = React.useMemo(
    () => JSON.stringify({ arguments: item.args, output: item.output ?? null }, null, 2),
    [item.args, item.output]
  )

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className={`text-xs text-muted-foreground ${mutedLinkClassName}`}
          aria-label={`View full call: ${item.tool} ${item.target}`}
        >
          View full call
        </button>
      </DialogTrigger>
      {/* No custom `onOpenAutoFocus` (unlike `TextPreviewModal.tsx`): the Formatted tab's own
       * trigger is already the first focusable descendant in DOM order (before any section's
       * Copy button, and before the dialog's own Close button, which `DialogContent` renders
       * after `children`), so Radix's default initial-focus search already lands there. */}
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate" title={`${item.tool} ${item.target}`}>
            {item.tool} {item.target}
          </DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="formatted" className="flex min-h-0 flex-1 flex-col gap-2">
          <TabsList className="self-start">
            <TabsTrigger value="formatted">Formatted</TabsTrigger>
            <TabsTrigger value="json">JSON</TabsTrigger>
          </TabsList>
          <TabsContent value="formatted" className="min-h-0 flex-1 space-y-3 overflow-auto">
            <div className="flex items-center gap-2 text-sm">
              <StatusIcon status={item.status} />
              <span className="shrink-0 text-xs text-muted-foreground">
                {toolStatusLabel(item.status)}
                {item.durationMs != null ? ` · ${formatDuration(item.durationMs)}` : ''}
              </span>
            </div>
            {sections.map((section) => (
              <SectionBlock key={section.label} section={section} />
            ))}
            {outputBlock != null && (
              <SectionBlock section={{ label: 'Output', lang: outputBlock.lang, code: outputBlock.code }} />
            )}
          </TabsContent>
          <TabsContent value="json" className="min-h-0 flex-1 overflow-auto">
            <CappedCodeBlock code={jsonText} lang="json" />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
