import * as React from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { parsePseudoShell, type PseudoKind, type PseudoStep } from './pseudoShell'
import { CappedCodeBlock, SectionHeader, type Section } from './ToolSectionBlock'

type CommandView = 'raw' | 'pseudo'

const KIND_LABEL: Record<PseudoKind, string> = {
  command: 'Run',
  cd: 'Change directory',
  pipe: 'Pipe into',
  redirect: 'Redirect',
  assign: 'Set variable',
  condition: 'Condition',
  subshell: 'Subshell',
  background: 'Background'
}

// Static class names so Tailwind sees them; deeper nesting than this reads the same as the last level.
const INDENT = ['pl-0', 'pl-4', 'pl-8', 'pl-12']

function PseudoStepList({ steps }: { steps: PseudoStep[] }) {
  return (
    <ol aria-label="Command steps" className="space-y-1 rounded-md border border-border p-2 text-xs">
      {steps.map((step, index) => (
        <li key={index} className={`flex items-baseline gap-2 ${INDENT[Math.min(step.depth, INDENT.length - 1)]}`}>
          <span className="w-28 shrink-0 text-muted-foreground">{KIND_LABEL[step.kind]}</span>
          <code className="min-w-0 break-all font-mono">{step.text}</code>
        </li>
      ))}
    </ol>
  )
}

// The body for a chosen view, apart from the toggle's state so each view can be rendered directly.
export function BashCommandBody({ view, code, lang }: { view: CommandView; code: string; lang: string | null }) {
  const parsed = React.useMemo(() => parsePseudoShell(code), [code])
  if (view === 'pseudo' && parsed.ok) return <PseudoStepList steps={parsed.steps} />
  return (
    <>
      {view === 'pseudo' && <p className="mb-1 text-xs text-muted-foreground">Can't show this command as steps.</p>}
      <CappedCodeBlock code={code} lang={lang} hideCopy />
    </>
  )
}

// #1750: Raw is the command as written and stays the default; Pseudo is the same command read as
// Python-like steps, built from the text alone. A command the reader refuses shows the Raw text and a note.
export function BashCommandSection({ section }: { section: Section }) {
  const [view, setView] = React.useState<CommandView>('raw')
  return (
    <div>
      <SectionHeader section={section}>
        <ToggleGroup
          type="single"
          value={view}
          onValueChange={(value) => {
            if (value === 'raw' || value === 'pseudo') setView(value)
          }}
          size="sm"
          aria-label={`${section.label} view`}
        >
          <ToggleGroupItem value="raw">Raw</ToggleGroupItem>
          <ToggleGroupItem value="pseudo">Pseudo</ToggleGroupItem>
        </ToggleGroup>
      </SectionHeader>
      <BashCommandBody view={view} code={section.code} lang={section.lang} />
    </div>
  )
}
