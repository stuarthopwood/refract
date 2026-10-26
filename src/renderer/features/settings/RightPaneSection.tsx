// Spec 013 FR-020 to FR-022 (research.md decision 7): a dedicated Settings section for the one
// "Show sample data" switch, not folded into Appearance -- this is about right-pane content, not
// visual theme. Immediate apply, no Save step, the same pattern `ChatDisplaySection.tsx` already
// uses for its own two switches (and `watermarkEnabled`'s own toggle in `AppearanceSection.tsx`).
//
// Scope note: this section persists the setting and exposes it to the renderer
// (`Settings.showSampleData`, `useSettingsStore`); `FdbKnowledgePanel.tsx`/
// `AgentBuilderPanel.tsx` are the consumers that actually switch between the empty state and
// their own sample content (FR-021/FR-022) off this same boolean.
import { useEffect, useRef } from 'react'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/state'

export function RightPaneSection() {
  const showSampleData = useSettingsStore((state) => state.settings.showSampleData)
  const setShowSampleData = useSettingsStore((state) => state.setShowSampleData)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1} className="mb-1 text-base font-semibold outline-none">
        Right pane
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Choose what the FDB Knowledge and Agent Builder panels show before either integration exists.
      </p>
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <label htmlFor="show-sample-data-toggle" className="text-sm">
            Show sample data
          </label>
          <span id="show-sample-data-toggle-description" className="text-xs text-muted-foreground">
            Believable example content for FDB Knowledge and Agent Builder, each element labelled "Sample data". Off shows the honest empty state instead.
          </span>
        </div>
        <Switch
          id="show-sample-data-toggle"
          aria-describedby="show-sample-data-toggle-description"
          checked={showSampleData}
          onCheckedChange={(checked) => void setShowSampleData(checked)}
        />
      </div>
    </div>
  )
}
