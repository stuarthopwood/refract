// Spec 013 FR-020 to FR-022 (research.md decision 7): Settings > Panels (formerly "Right pane"),
// a dedicated section for the one "Show sample data" switch, not folded into Appearance -- this is
// about right-pane content, not visual theme. Immediate apply, no Save step, the same pattern
// `ChatDisplaySection.tsx` already uses for its own switches. Spec 036: built from the shared
// `SettingsPage` / `SettingsGroup` / `SettingRow`.
//
// Scope note: this section persists the setting and exposes it to the renderer
// (`Settings.showSampleData`, `useSettingsStore`); `FdbKnowledgePanel.tsx`/
// `AgentBuilderPanel.tsx` are the consumers that actually switch between the empty state and
// their own sample content (FR-021/FR-022) off this same boolean.
import { useState } from 'react'
import { SettingRow } from '@/components/settings/SettingRow'
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { SettingSwitchRow } from '@/components/SettingSwitchRow'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/state'
import { resetPanelOrder } from '../right-pane/panel-order'

export function RightPaneSection() {
  const showSampleData = useSettingsStore((state) => state.settings.showSampleData)
  const setShowSampleData = useSettingsStore((state) => state.setShowSampleData)
  const [orderReset, setOrderReset] = useState(false)

  return (
    <SettingsPage
      title="Panels"
      intro="Choose what the FDB Knowledge and Agent Builder panels show before either integration exists, and how the right pane's panels are ordered."
    >
      <SettingsGroup title="FDB Knowledge and Agent Builder">
        <SettingSwitchRow
          id="show-sample-data-toggle"
          label="Show sample data"
          description='Believable example content for FDB Knowledge and Agent Builder, each element labelled "Sample data". Off shows the honest empty state instead.'
          checked={showSampleData}
          onCheckedChange={(checked) => void setShowSampleData(checked)}
        />
      </SettingsGroup>
      <SettingsGroup title="Right pane">
        <SettingRow
          id="panel-order"
          label="Panel order"
          labelAsText
          description="Drag the buttons on the right edge, or press Alt+Shift+Up or Down on one, to rearrange the panels."
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-describedby="panel-order-description"
            onClick={() => {
              resetPanelOrder()
              setOrderReset(true)
            }}
          >
            Reset panel order
          </Button>
        </SettingRow>
      </SettingsGroup>
      <div role="status" className="sr-only">
        {orderReset ? 'Panel order reset to the default.' : ''}
      </div>
    </SettingsPage>
  )
}
