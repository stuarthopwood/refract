import * as React from 'react'
import type { TranscriptItem } from '../../../shared/model'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { inferOutputBlock, mutedLinkClassName } from './Markdown'
import { formatDuration, StatusIcon, toolStatusLabel } from './toolStatus'
import { CappedCodeBlock, SectionBlock, type Section } from './ToolSectionBlock'
import { defaultSectionView } from './toolViewRules'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

// WCAG 2.5.3/accessible-name sanity (quality-gate, Low round 2; Medium round 3): an agent-
// authored `item.target` can be an arbitrarily long or multi-line bash command; a screen reader
// would otherwise read the entire thing as the link's name on every visit. Truncated with an
// ellipsis past 80 chars (never dropped -- FR-061 says the name MUST include both the tool and
// the target) -- the full target is still the row's own visible summary text right next to the
// link.
const ARIA_LABEL_MAX_CHARS = 80

// Each key of a tool call's own `args` becomes its own labelled section (#628 Formatted tab):
// a string value is shown exactly as written, as plain text with real line breaks (a `bash`
// call's own `command` highlighted as `bash`, and a `write` call's own `content` re-parsed and
// pretty-printed when it is itself JSON -- both match the pre-#628 `inferArgumentsBlock` special
// cases, DESIGN.md "Every JSON-shaped tool/code surface uses `CodeBlock`") -- never reparsed
// otherwise, unlike the JSON tab's single, faithful `JSON.stringify`. A non-string value (number,
// boolean, object, array, null) has no "real line breaks" of its own, so it is pretty-printed as
// JSON instead.
function argumentSections(item: ToolItem): Section[] {
  if (item.args && typeof item.args === 'object' && !Array.isArray(item.args)) {
    const entries = Object.entries(item.args as Record<string, unknown>)
    if (entries.length > 0) {
      return entries.map(([key, value]) => {
        if (typeof value === 'string') {
          if (item.tool === 'bash' && key === 'command') return { label: key, lang: 'bash', code: value, defaultView: 'source' }
          if (item.tool === 'write' && key === 'content') {
            try {
              return { label: key, lang: 'json', code: JSON.stringify(JSON.parse(value), null, 2), defaultView: 'source' }
            } catch {
              // `content` is plain file text, not JSON -- fall through to the plain-text case.
            }
          }
          return { label: key, lang: null, code: value, defaultView: defaultSectionView(item.tool, key, item.target) }
        }
        return { label: key, lang: 'json', code: JSON.stringify(value, null, 2), defaultView: 'source' }
      })
    }
  }
  return [{ label: 'Arguments', lang: 'json', code: JSON.stringify(item.args ?? null, null, 2), defaultView: 'source' }]
}

// Quality-gate remediation (Medium): split out of `ToolCallDialog` so its memos (`argumentSections`,
// `inferOutputBlock`'s JSON.parse/stringify, and the full `JSON.stringify({arguments, output})`)
// and the `<Tabs>` tree only ever run as a CHILD of `<DialogContent>` -- Radix does not mount a
// closed dialog's content subtree at all, so this component's own hooks never run for a row that
// is merely expanded but whose dialog was never opened. Deps are narrowed to the specific fields
// each computation actually reads (not `[item]` as a whole), so a streaming item update that
// changes only, say, `durationMs` does not re-run a megabyte output's JSON.parse/stringify.
function ToolCallDialogBody({ item }: { item: ToolItem }) {
  const sections = React.useMemo(() => argumentSections(item), [item.tool, item.args, item.target])
  const outputBlock = React.useMemo(() => (item.output != null ? inferOutputBlock(item.output) : null), [item.output])
  const jsonText = React.useMemo(
    () => JSON.stringify({ arguments: item.args, output: item.output ?? null }, null, 2),
    [item.args, item.output]
  )
  // `focus-visible:outline-hidden` (forced-colours) alongside the normal-mode `ring-2` (Windows
  // High Contrast ignores box-shadow, which is how the `ring-*` utilities paint -- same pattern
  // as `radio-group.tsx`); Radix's own Tab panel is a `tabIndex=0` scroll region with no focus
  // style of its own otherwise (quality-gate, High).
  const panelClassName =
    'min-h-0 flex-1 overflow-auto outline-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset'

  return (
    <Tabs defaultValue="formatted" className="flex min-h-0 flex-1 flex-col gap-2">
      <TabsList className="self-start">
        <TabsTrigger value="formatted">Formatted</TabsTrigger>
        <TabsTrigger value="json">JSON</TabsTrigger>
      </TabsList>
      <TabsContent value="formatted" className={`${panelClassName} space-y-2`}>
        <div className="flex items-center gap-2 text-sm">
          <StatusIcon status={item.status} />
          <span className="shrink-0 text-xs text-muted-foreground">
            {toolStatusLabel(item.status)}
            {item.durationMs != null ? ` · ${formatDuration(item.durationMs)}` : ''}
          </span>
        </div>
        {sections.map((section) => (
          <SectionBlock key={`arg:${section.label}`} section={section} />
        ))}
        {outputBlock != null && (
          <SectionBlock key="__output" section={{
              label: 'Output',
              lang: outputBlock.lang,
              code: outputBlock.code,
              defaultView: defaultSectionView(item.tool, 'Output', item.target)
            }}
          />
        )}
      </TabsContent>
      <TabsContent value="json" className={panelClassName}>
        <CappedCodeBlock code={jsonText} lang="json" />
      </TabsContent>
    </Tabs>
  )
}

export interface ToolCallDialogProps {
  item: ToolItem
  /** Controlled (quality-gate remediation, A11y Medium): held by `ToolRow.tsx`'s `ToolGroupRow`,
   * above the tree position whose element type changes when a solo call's group gains a second
   * call of the same tool -- see that component's own comment for why an uncontrolled, locally-
   * owned `open` state silently lost the open dialog and its focus in that case. */
  open: boolean
  onOpenChange: (open: boolean) => void
}

// The "View full call" link and its dialog (#628, #630): reuses `TextPreviewModal.tsx`'s own
// Radix dialog pattern (focus returns to the trigger on Esc/outside click by Radix's own
// default, since the trigger here is always a real, always-mounted button). A text link, never
// a button (the issue's own wording) -- same underline-only, row-muted style `FileLinkButton`
// uses on a `bg-muted` surface, since this sits in the row's own muted expansion content, not on
// an accent-coloured surface. Two tabs: Formatted (default, the readable view -- a small header,
// each argument as its own section, then Output) and JSON (the exact arguments and output,
// pretty-printed in one code block, the faithful record for a bug report). Never markdown
// (constitution V): plain-text values are inert text, or the sanitising `Markdown` when the
// Rendered view applies (#719, never images); nothing here is ever parsed as raw markup.
export function ToolCallDialog({ item, open, onOpenChange }: ToolCallDialogProps) {
  const fullName = `${item.tool} ${item.target}`
  // Quality-gate remediation (Medium, round 3): truncates rather than drops the target once the
  // combined name passes 80 characters, so the accessible name always "includes the tool and
  // target" (FR-061) instead of silently falling back to the tool alone for a long bash command.
  const ariaLabel =
    fullName.length > ARIA_LABEL_MAX_CHARS ? `View full call: ${fullName.slice(0, ARIA_LABEL_MAX_CHARS)}…` : `View full call: ${fullName}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={`text-xs text-muted-foreground ${mutedLinkClassName}`}
          aria-label={ariaLabel}
        >
          View full call
        </button>
      </DialogTrigger>
      {/* No custom `onOpenAutoFocus` (unlike `TextPreviewModal.tsx`): the Formatted tab's own
       * trigger is already the first focusable descendant in DOM order (before any section's
       * Copy button, and before the dialog's own Close button, which `DialogContent` renders
       * after `children`), so Radix's default initial-focus search already lands there. */}
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader className="pr-8">
          <DialogTitle className="truncate" title={fullName}>
            {item.tool} {item.target}
          </DialogTitle>
          {/* Quality-gate remediation (Medium): Radix logs a "Missing Description" dev warning
           * without one; every other Dialog in the app has one. sr-only since the visible title
           * plus the tabs below already say everything a sighted user needs. */}
          <DialogDescription className="sr-only">Arguments and output of this tool call, formatted or as JSON.</DialogDescription>
        </DialogHeader>
        <ToolCallDialogBody item={item} />
      </DialogContent>
    </Dialog>
  )
}
