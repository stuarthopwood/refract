// Issue #457: two independent Settings switches for what the chat transcript shows -- Show
// thinking output and Show tool calls. Immediate apply, no Save step, matching the existing
// "Session readout" toggles' own pattern (`SettingsScreen.tsx`) and the issue's own suggested
// default behaviour ("They apply immediately, like the readout toggles, with no Save step").
//
// Scope note: this section only persists the setting and exposes it to the renderer
// (`Settings.transcriptDisplay`, `useSettingsStore`) -- applying the actual view filter inside the
// chat transcript (`Transcript.tsx`/`ToolRow.tsx`) is Phase A territory this story does not touch;
// see this story's PR body.
import { useEffect, useRef } from 'react'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/state'

export function ChatDisplaySection() {
  const transcriptDisplay = useSettingsStore((state) => state.settings.transcriptDisplay)
  const setTranscriptDisplay = useSettingsStore((state) => state.setTranscriptDisplay)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1} className="mb-1 text-base font-semibold outline-none">
        Chat
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">Choose what the chat transcript shows, for every open session.</p>
      <div className="flex flex-col divide-y divide-border">
        <div className="flex items-center justify-between gap-4 py-3">
          <label htmlFor="transcript-display-thinking" className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Show thinking output</span>
            <span className="text-xs text-muted-foreground">The agent's reasoning while it works.</span>
          </label>
          <Switch
            id="transcript-display-thinking"
            checked={transcriptDisplay.thinking}
            onCheckedChange={(checked) => void setTranscriptDisplay({ ...transcriptDisplay, thinking: checked })}
          />
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <label htmlFor="transcript-display-tool-calls" className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Show tool calls</span>
            <span className="text-xs text-muted-foreground">
              Tool calls the agent makes. Approvals, questions, and failed calls always show.
            </span>
          </label>
          <Switch
            id="transcript-display-tool-calls"
            checked={transcriptDisplay.toolCalls}
            onCheckedChange={(checked) => void setTranscriptDisplay({ ...transcriptDisplay, toolCalls: checked })}
          />
        </div>
      </div>
    </div>
  )
}
