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
//
// Issue #772 (lane R6, Rust build only; Main's review decision 2026-10-14): the word-prediction
// (ghost-text) toggle below calls `settings.setWordPredictionEnabled`, which has no Electron
// implementation -- `Settings.wordPredictionEnabled` stays `undefined` there forever (Electron's
// `settings.ts` never sets it), so the toggle is simply never rendered on Electron (no
// "unsupported" toast to show); Electron keeps ghost text always on instead (`MessageInput.tsx`'s
// own `wordPredictionEnabled !== false` read treats absent as enabled).
import { useEffect, useRef } from 'react'
import { SettingSwitchRow } from '@/components/SettingSwitchRow'
import { useSettingsStore } from '@/state'

export function ChatDisplaySection() {
  const transcriptDisplay = useSettingsStore((state) => state.settings.transcriptDisplay)
  const setTranscriptDisplay = useSettingsStore((state) => state.setTranscriptDisplay)
  const detectImagePathsOnPaste = useSettingsStore((state) => state.settings.detectImagePathsOnPaste)
  const setDetectImagePathsOnPaste = useSettingsStore((state) => state.setDetectImagePathsOnPaste)
  const showContextUsageBar = useSettingsStore((state) => state.settings.showContextUsageBar !== false)
  const setShowContextUsageBar = useSettingsStore((state) => state.setShowContextUsageBar)
  const wordPredictionEnabled = useSettingsStore((state) => state.settings.wordPredictionEnabled)
  const setWordPredictionEnabled = useSettingsStore((state) => state.setWordPredictionEnabled)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1} className="mb-1 text-base font-semibold outline-none">
        Chat
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Choose what the chat transcript shows, how pasted content is handled, and how context usage is drawn
        {wordPredictionEnabled !== undefined && ', and whether word suggestions appear while you type'}.
      </p>
      <div className="flex flex-col divide-y divide-border">
        <SettingSwitchRow
          id="transcript-display-thinking"
          label="Show thinking output"
          description="The agent's reasoning while it works."
          checked={transcriptDisplay.thinking}
          onCheckedChange={(checked) => void setTranscriptDisplay('thinking', checked)}
        />
        <SettingSwitchRow
          id="transcript-display-tool-calls"
          label="Show tool calls"
          description="Tool calls and subagents the agent runs. Approvals, questions, failed or interrupted calls, and the subagent chain always show."
          checked={transcriptDisplay.toolCalls}
          onCheckedChange={(checked) => void setTranscriptDisplay('toolCalls', checked)}
        />
        {/* Issue #469: off by default. */}
        <SettingSwitchRow
          id="transcript-display-tool-names"
          label="Show tool names on rows"
          description="The raw tool name, shown muted after each tool row's label."
          checked={transcriptDisplay.toolNames}
          onCheckedChange={(checked) => void setTranscriptDisplay('toolNames', checked)}
        />
        <SettingSwitchRow
          id="detect-image-paths-on-paste"
          label="Attach images pasted as a file path"
          description={'A pasted path to an image file (for example, Explorer\'s "Copy as path") attaches the image above the message box.'}
          checked={detectImagePathsOnPaste}
          onCheckedChange={(checked) => void setDetectImagePathsOnPaste(checked)}
        />
        {/* Issue #1082 (spec 004 FR-034): on by default. */}
        <SettingSwitchRow
          id="show-context-usage-bar"
          label="Show context usage bar"
          description="A thin bar under the context usage figures, filled to how much of the context window is in use."
          checked={showContextUsageBar}
          onCheckedChange={(checked) => void setShowContextUsageBar(checked)}
        />
        {wordPredictionEnabled !== undefined && (
          <SettingSwitchRow
            id="word-prediction-enabled"
            label="Word prediction (ghost text)"
            description="Suggests how to finish the word you're typing in the message box. Off by default: the shared prediction engine can use several hundred MB of memory once started."
            checked={wordPredictionEnabled}
            onCheckedChange={(checked) => void setWordPredictionEnabled(checked)}
          />
        )}
      </div>
    </div>
  )
}
