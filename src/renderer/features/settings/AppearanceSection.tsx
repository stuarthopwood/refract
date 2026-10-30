import { useRef } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/settings/SettingRow'
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { SettingSwitchRow } from '@/components/SettingSwitchRow'
import { SELECTED_SEGMENT_CLASS, ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { BrandWatermark } from '@/features/chat/BrandWatermark'
import { HOLIDAY_CONTENT } from '@/features/holidays/holidayContent'
import { useHolidayStore, useSettingsStore } from '@/state'
import { ThemePicker } from './ThemePicker'
import { ChatWidthPicker } from './ChatWidthPicker'
import { TextSizeGroup } from './TextSizeGroup'
import { ChatRowSpacingGroup } from './ChatRowSpacingGroup'
import { StatusStylePicker } from './StatusStylePicker'

export function AppearanceSection() {
  const watermarkEnabled = useSettingsStore((state) => state.settings.watermarkEnabled)
  const setWatermarkEnabled = useSettingsStore((state) => state.setWatermarkEnabled)
  const holidayTouches = useSettingsStore((state) => state.settings.holidayTouches)
  const setHolidayTouches = useSettingsStore((state) => state.setHolidayTouches)
  const activityText = useSettingsStore((state) => state.settings.activityText ?? 'plain')
  const setActivityText = useSettingsStore((state) => state.setActivityText)
  const animatedStatusText = useSettingsStore((state) => state.settings.animatedStatusText !== false)
  const setAnimatedStatusText = useSettingsStore((state) => state.setAnimatedStatusText)
  const activeHolidayId = useHolidayStore((state) => state.activeHoliday)
  const holidayEntry = holidayTouches !== 'off' && activeHolidayId ? HOLIDAY_CONTENT[activeHolidayId] : null
  const headingRef = useRef<HTMLHeadingElement>(null)

  // SettingsPage focuses this heading (shared via headingRef) on mount, which covers every
  // section switch because SettingsScreen never keeps a section mounted-but-hidden.

  return (
    <div>
      <SettingsPage title="Appearance" intro="Choose how the app looks and reads." headingRef={headingRef}>
        {/* Issue #554 gate round 2 (L1): each group has its own heading and hint, wired via
            aria-labelledby/aria-describedby on the picker -- the intro above is the shared lead-in
            for the whole section, not Theme's own. */}
        <div className="mb-6">
          <SettingsGroup title="Theme" headingId="theme-heading" description="The colour palette used across the app." descriptionId="theme-hint">
            <div className="pt-2">
              <ThemePicker labelledBy="theme-heading" describedBy="theme-hint" />
            </div>
          </SettingsGroup>
          <SettingsGroup title="Chat width" headingId="chat-width-heading" description="How wide the chat transcript reads." descriptionId="chat-width-hint">
            <div className="pt-2">
              <ChatWidthPicker labelledBy="chat-width-heading" describedBy="chat-width-hint" />
            </div>
          </SettingsGroup>
        </div>
        {/* Spec 036 (#842): applies live, no Save/Cancel. */}
        <TextSizeGroup />
        <ChatRowSpacingGroup />
        {/* Spec 012 (research.md decisions 9, 14) and #1048: these apply live. */}
        <SettingsGroup title="Decoration">
          <div>
            {/* Quality-gate remediation (accessibility-auditor, Low): only the title is the label;
                the description is wired in via `aria-describedby` so it is announced once, as a hint. */}
            <SettingRow
              id="watermark-toggle"
              label="Background watermark"
              description={holidayEntry ? 'A faint mark shown in the corner of the chat area — a seasonal glyph while a holiday is active.' : 'A faint Refract mark shown in the corner of the chat area.'}
            >
              <Switch
                id="watermark-toggle"
                aria-describedby="watermark-toggle-description"
                checked={watermarkEnabled}
                onCheckedChange={(checked) => void setWatermarkEnabled(checked)}
              />
            </SettingRow>
            <div className="mb-4 flex size-28 items-center justify-center rounded-md border border-border">
              <BrandWatermark variant="preview" />
            </div>
          </div>
          <SettingRow
            id="holiday-touches"
            controlId="holiday-touches-select"
            label="Holiday touches"
            description="Seasonal artwork and ambient motion near a holiday."
          >
            <Select value={holidayTouches} onValueChange={(value) => void setHolidayTouches(value as typeof holidayTouches)}>
              <SelectTrigger id="holiday-touches-select" aria-describedby="holiday-touches-description" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full">Full</SelectItem>
                <SelectItem value="artwork">Artwork only</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        </SettingsGroup>
        {/* Issue #482: applies live, like Activity; the picker carries its own preview. */}
        <SettingsGroup
          title="Status style"
          headingId="status-style-heading"
          description="How each Session's state is drawn in the Session list, chat header and details card."
          descriptionId="status-style-hint"
        >
          <div className="pt-2">
            <StatusStylePicker labelledBy="status-style-heading" describedBy="status-style-hint" />
          </div>
        </SettingsGroup>
        <SettingsGroup title="Activity">
          {/* #526 (FR-111): the shared segmented `ToggleGroup` (ProviderSwitch,
              ManageSessionsToolbar) -- no one-off control. */}
          <SettingRow
            id="activity-text"
            label="Activity text"
            labelAsText
            description={
              <>
                Shown for each Session in the Session list and in the banner above the composer when it has
                nothing more specific to say. Plain shows &ldquo;Working…&rdquo;; Playful shows a friendly
                phrase such as &ldquo;On it…&rdquo;.
              </>
            }
          >
            <ToggleGroup
              type="single"
              value={activityText}
              onValueChange={(value) => {
                // Radix emits '' when the selected segment is clicked again; keep one selected.
                if (value === 'plain' || value === 'playful') void setActivityText(value)
              }}
              variant="outline"
              size="sm"
              spacing={0}
              aria-labelledby="activity-text-label"
              aria-describedby="activity-text-description"
            >
              <ToggleGroupItem value="plain" className={SELECTED_SEGMENT_CLASS}>Plain</ToggleGroupItem>
              <ToggleGroupItem value="playful" className={SELECTED_SEGMENT_CLASS}>Playful</ToggleGroupItem>
            </ToggleGroup>
          </SettingRow>
          {/* Issue #1242 (FR-042): also lets the user stop the looping shimmer (WCAG 2.2.2). */}
          <SettingSwitchRow
            id="animated-status-text"
            label="Animated status text"
            description="A moving highlight on the banner above the composer while the agent is working. Always still when you have reduced motion on."
            checked={animatedStatusText}
            onCheckedChange={(checked) => void setAnimatedStatusText(checked)}
          />
        </SettingsGroup>
      </SettingsPage>
    </div>
  )
}