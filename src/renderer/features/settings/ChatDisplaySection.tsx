// Issue #457: two independent Settings switches for what the chat transcript shows -- Show
// thinking output and Show tool calls. Immediate apply, no Save step, matching the existing
// "Session readout" toggles' own pattern (`SettingsScreen.tsx`) and the issue's own suggested
// default behaviour ("They apply immediately, like the readout toggles, with no Save step").
//
// Scope note: this section persists the setting and exposes it to the renderer
// (`Settings.transcriptDisplay`, `useSettingsStore`); `Transcript.tsx`'s `rowVisibility` is the
// consumer that actually filters the rendered rows from these two booleans (a `thinking` row for
// the first switch; a `ToolGroup`/`subagent` row, unless it reports an error/interruption, for the
// second -- see that function's own comment for the full "never hide a problem" rule this
// section's description text below summarises).
//
// Quality-gate remediation: `setTranscriptDisplay` now takes one field at a time (not the whole
// object spread from the current render), so toggling the second switch before the first save
// returns can no longer revert it -- the merge happens in main against the persisted row, the
// same per-field pattern the existing readout toggles already use.
import { useEffect, useRef } from 'react'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/state'

export function ChatDisplaySection() {
  const transcriptDisplay = useSettingsStore((state) => state.settings.transcriptDisplay)
  const setTranscriptDisplay = useSettingsStore((state) => state.setTranscriptDisplay)
  const detectImagePathsOnPaste = useSettingsStore((state) => state.settings.detectImagePathsOnPaste)
  const setDetectImagePathsOnPaste = useSettingsStore((state) => state.setDetectImagePathsOnPaste)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1} className="mb-1 text-base font-semibold outline-none">
        Chat
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">Choose what the chat transcript shows and how pasted content is handled.</p>
      <div className="flex flex-col divide-y divide-border">
        <div className="flex items-center justify-between gap-4 py-3">
          <div className="flex flex-col gap-0.5">
            <label htmlFor="transcript-display-thinking" className="text-sm font-medium">
              Show thinking output
            </label>
            <span id="transcript-display-thinking-description" className="text-xs text-muted-foreground">
              The agent's reasoning while it works.
            </span>
          </div>
          <Switch
            id="transcript-display-thinking"
            aria-describedby="transcript-display-thinking-description"
            checked={transcriptDisplay.thinking}
            onCheckedChange={(checked) => void setTranscriptDisplay('thinking', checked)}
          />
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <div className="flex flex-col gap-0.5">
            <label htmlFor="transcript-display-tool-calls" className="text-sm font-medium">
              Show tool calls
            </label>
            <span id="transcript-display-tool-calls-description" className="text-xs text-muted-foreground">
              Tool calls and subagents the agent runs. Approvals, questions, and failed or interrupted calls always show.
            </span>
          </div>
          <Switch
            id="transcript-display-tool-calls"
            aria-describedby="transcript-display-tool-calls-description"
            checked={transcriptDisplay.toolCalls}
            onCheckedChange={(checked) => void setTranscriptDisplay('toolCalls', checked)}
          />
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <div className="flex flex-col gap-0.5">
            <label htmlFor="detect-image-paths-on-paste" className="text-sm font-medium">
              Attach images pasted as a file path
            </label>
            <span id="detect-image-paths-on-paste-description" className="text-xs text-muted-foreground">
              A pasted path to an image file (for example, Explorer's "Copy as path") attaches the image above the message box.
            </span>
          </div>
          <Switch
            id="detect-image-paths-on-paste"
            aria-describedby="detect-image-paths-on-paste-description"
            checked={detectImagePathsOnPaste}
            onCheckedChange={(checked) => void setDetectImagePathsOnPaste(checked)}
          />
        </div>
      </div>
    </div>
  )
}
