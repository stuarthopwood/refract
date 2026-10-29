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
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { SettingSwitchRow } from '@/components/SettingSwitchRow'
import { useSettingsStore } from '@/state'

export function ChatDisplaySection() {
  const transcriptDisplay = useSettingsStore((state) => state.settings.transcriptDisplay)
  const setTranscriptDisplay = useSettingsStore((state) => state.setTranscriptDisplay)
  const detectImagePathsOnPaste = useSettingsStore((state) => state.settings.detectImagePathsOnPaste)
  const setDetectImagePathsOnPaste = useSettingsStore((state) => state.setDetectImagePathsOnPaste)
  const showContextUsageBar = useSettingsStore((state) => state.settings.showContextUsageBar !== false)
  const setShowContextUsageBar = useSettingsStore((state) => state.setShowContextUsageBar)
  const showAiCredits = useSettingsStore((state) => state.settings.showAiCredits !== false)
  const setShowAiCredits = useSettingsStore((state) => state.setShowAiCredits)
  const showFinishedTurnTimes = useSettingsStore((state) => state.settings.showFinishedTurnTimes === true)
  const setShowFinishedTurnTimes = useSettingsStore((state) => state.setShowFinishedTurnTimes)
  const wordPredictionEnabled = useSettingsStore((state) => state.settings.wordPredictionEnabled)
  const setWordPredictionEnabled = useSettingsStore((state) => state.setWordPredictionEnabled)
  const codeLigatures = useSettingsStore((state) => state.settings.codeLigatures !== false)
  const setCodeLigatures = useSettingsStore((state) => state.setCodeLigatures)

  return (
    <SettingsPage
      title="Chat"
      intro={
        <>
          Choose what the chat transcript shows, how pasted content is handled, and how context usage is drawn
          {wordPredictionEnabled !== undefined && ', and whether word suggestions appear while you type'}.
        </>
      }
    >
      <SettingsGroup title="Transcript">
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
        {/* Issue #1250 (spec 001 FR-119): off by default; the running turn's live total always shows. */}
        <SettingSwitchRow
          id="show-finished-turn-times"
          label="Show finished turn times"
          description="How long each turn took, shown under it (and read out by screen readers) once it finishes. A turn that is still running always shows its timer."
          checked={showFinishedTurnTimes}
          onCheckedChange={(checked) => void setShowFinishedTurnTimes(checked)}
        />
        {/* Issue #1246: on by default. */}
        <SettingSwitchRow
          id="code-ligatures"
          label="Code ligatures"
          description="Join characters such as => and != into single glyphs in code, diffs and the message box."
          checked={codeLigatures}
          onCheckedChange={(checked) => void setCodeLigatures(checked)}
        />
      </SettingsGroup>
      <SettingsGroup title="Message box">
        <SettingSwitchRow
          id="detect-image-paths-on-paste"
          label="Attach images pasted as a file path"
          description={'A pasted path to an image file (for example, Explorer\'s "Copy as path") attaches the image above the message box.'}
          checked={detectImagePathsOnPaste}
          onCheckedChange={(checked) => void setDetectImagePathsOnPaste(checked)}
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
      </SettingsGroup>
      <SettingsGroup title="Context usage">
        {/* Issue #1082 (spec 004 FR-034): on by default. */}
        <SettingSwitchRow
          id="show-context-usage-bar"
          label="Show context usage bar"
          description="A thin bar under the context usage figures, filled to how much of the context window is in use."
          checked={showContextUsageBar}
          onCheckedChange={(checked) => void setShowContextUsageBar(checked)}
        />
        {/* Issue #1238 (spec 004 FR-053): on by default; Copilot models only. */}
        <SettingSwitchRow
          id="show-ai-credits"
          label="Show AI credits and plan usage"
          description="The session's AI credits next to the context usage figures, with your Copilot plan usage in its tooltip. Copilot models only, and only while the context usage readout is on."
          checked={showAiCredits}
          onCheckedChange={(checked) => void setShowAiCredits(checked)}
        />
      </SettingsGroup>
    </SettingsPage>
  )
}
