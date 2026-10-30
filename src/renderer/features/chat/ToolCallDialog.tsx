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

const ARIA_LABEL_MAX_CHARS = 80

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

function ToolCallDialogBody({ item }: { item: ToolItem }) {
  const sections = React.useMemo(() => argumentSections(item), [item.tool, item.args, item.target])
  const outputBlock = React.useMemo(() => (item.output != null ? inferOutputBlock(item.output) : null), [item.output])
  const jsonText = React.useMemo(
    () => JSON.stringify({ arguments: item.args, output: item.output ?? null }, null, 2),
    [item.args, item.output]
  )
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
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ToolCallDialog({ item, open, onOpenChange }: ToolCallDialogProps) {
  const fullName = `${item.tool} ${item.target}`
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
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader className="pr-8">
          <DialogTitle className="truncate" title={fullName}>
            {item.tool} {item.target}
          </DialogTitle>
          <DialogDescription className="sr-only">Arguments and output of this tool call, formatted or as JSON.</DialogDescription>
        </DialogHeader>
        <ToolCallDialogBody item={item} />
      </DialogContent>
    </Dialog>
  )
}
