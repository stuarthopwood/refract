import { SourceTag } from '@/components/SourceTag'
import type { ContextLine } from '../../../shared/contextLines'
import { CONTEXT_PRESENTATION } from './contextLinePresentation'

/** Refract's own lines at the top of a user bubble, set apart from what the user typed below them. */
export function ContextLineStrip({ lines }: { lines: ContextLine[] }) {
  return (
    <div data-slot="context-line-strip" className="mb-2 flex flex-col gap-1 border-b border-chat-user-bubble-border pb-2 text-xs">
      {lines.map((line, index) => (
        <SourceTag key={index} icon={CONTEXT_PRESENTATION[line.kind].icon} label={CONTEXT_PRESENTATION[line.kind].label} detail={line.text} tooltip={line.text} />
      ))}
    </div>
  )
}
