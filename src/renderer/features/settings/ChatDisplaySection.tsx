import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { SettingSwitchRow } from '@/components/SettingSwitchRow'
import { useSettingsStore } from '@/state'
import { useUsageStore } from '@/state/usage-store'
import { useEffect } from 'react'

export function ChatDisplaySection() {
  const usageJokes = useUsageStore((state) => state.jokes)
  const setUsageJokes = useUsageStore((state) => state.setJokes)
  useEffect(() => {
    void useUsageStore.getState().loadPrefs()
  }, [])
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
  const showScrollbarMap = useSettingsStore((state) => state.settings.showScrollbarMap !== false)
  const setShowScrollbarMap = useSettingsStore((state) => state.setShowScrollbarMap)

  return (
    <SettingsPage
      title="Chat"
      intro={
        <>
          Choose what the chat transcript shows, how pasted content is handled, and how context usage is drawn
          , and whether word suggestions appear while you type.
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
        <SettingSwitchRow
          id="transcript-display-tool-names"
          label="Show tool names on rows"
          description="The raw tool name, shown muted after each tool row's label."
          checked={transcriptDisplay.toolNames}
          onCheckedChange={(checked) => void setTranscriptDisplay('toolNames', checked)}
        />
        <SettingSwitchRow
          id="show-finished-turn-times"
          label="Show finished turn times"
          description="How long each turn took, shown under it (and read out by screen readers) once it finishes. A turn that is still running always shows its timer."
          checked={showFinishedTurnTimes}
          onCheckedChange={(checked) => void setShowFinishedTurnTimes(checked)}
        />
        <SettingSwitchRow
          id="code-ligatures"
          label="Code ligatures"
          description="Join characters such as => and != into single glyphs in code, diffs and the message box."
          checked={codeLigatures}
          onCheckedChange={(checked) => void setCodeLigatures(checked)}
        />
        <SettingSwitchRow
          id="show-scrollbar-map"
          label="Show scrollbar map"
          description="A strip beside the transcript's scrollbar with a mark for each of your messages and the agent's replies. Click or drag it to move around a long chat."
          checked={showScrollbarMap}
          onCheckedChange={(checked) => void setShowScrollbarMap(checked)}
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
        <SettingSwitchRow
          id="word-prediction-enabled"
          label="Word prediction (ghost text)"
          description="Suggests how to finish the word you're typing in the message box. Off by default: the shared prediction engine can use several hundred MB of memory once started."
          checked={wordPredictionEnabled}
          onCheckedChange={(checked) => void setWordPredictionEnabled(checked)}
        />
      </SettingsGroup>
      <SettingsGroup title="Context usage">
        <SettingSwitchRow
          id="show-context-usage-bar"
          label="Show context usage bar"
          description="A thin bar under the context usage figures, filled to how much of the context window is in use."
          checked={showContextUsageBar}
          onCheckedChange={(checked) => void setShowContextUsageBar(checked)}
        />
        <SettingSwitchRow
          id="show-ai-credits"
          label="Show AI credits"
          description="The session's AI credits in the status line, with your Copilot plan usage in its tooltip. Copilot models only."
          checked={showAiCredits}
          onCheckedChange={(checked) => void setShowAiCredits(checked)}
        />
      </SettingsGroup>
      <SettingsGroup title="Usage view">
        <SettingSwitchRow
          id="usage-jokes"
          label="Jokes on the Usage view"
          description="A caption under each Usage card and the frustration index. Off hides both; the numbers stay."
          checked={usageJokes}
          onCheckedChange={(checked) => void setUsageJokes(checked)}
        />
      </SettingsGroup>
    </SettingsPage>
  )
}
