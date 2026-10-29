// The Settings screen (spec 004 FR-011 to FR-016; wave 2 spec 035): a flat left section list
// (`SettingsNav`) beside the chosen section's page. Every section builds from the shared
// `SettingsPage` / `SettingsGroup` / `SettingRow`, and focuses its own heading on mount, so a
// section change always lands on the new content (the nav button is never left holding focus).
// Reached via the profile menu's Settings item (spec 008) and the gear control in SessionList.tsx.
import { Button } from '@/components/ui/button'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { ArrowLeftIcon } from 'lucide-react'
import { focusSettingsEntry } from '@/lib/focus'
import { useViewStore } from '@/state'
import { AppearanceSection } from './AppearanceSection'
import { ChatDisplaySection } from './ChatDisplaySection'
import { ModelRolesSection } from './ModelRolesSection'
import { AdvancedSection } from './AdvancedSection'
import { RightPaneSection } from './RightPaneSection'
import { SessionsSection } from './SessionsSection'
import { SettingsBrand } from './SettingsBrand'
import { SettingsNav } from './SettingsNav'
import { StatusLineSection } from './StatusLineSection'

export function SettingsScreen() {
  const settingsSection = useViewStore((state) => state.settingsSection) ?? 'appearance'
  const openChat = useViewStore((state) => state.openChat)
  const openSettings = useViewStore((state) => state.openSettings)

  function handleBackToChat(): void {
    openChat()
    // The SessionList row this returns focus to doesn't exist yet -- App.tsx remounts the whole
    // SessionList+ChatPane workspace on the same `view` flip this triggers, so the query has to
    // run after that remount commits, not synchronously here (see `focusSettingsEntry`'s own
    // doc comment).
    requestAnimationFrame(() => focusSettingsEntry())
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="drag-region titlebar-surface flex h-10 shrink-0 items-center gap-2 px-4">
        <Button
          variant="ghost"
          size="icon"
          className="no-drag-region size-6"
          aria-label="Back to chat"
          onClick={handleBackToChat}
        >
          <ArrowLeftIcon aria-hidden className="size-4" />
        </Button>
        <SettingsBrand />
        <span aria-hidden className="text-sm text-muted-foreground">/</span>
        <span className="text-sm font-medium">Settings</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <SettingsNav active={settingsSection} onSelect={openSettings} />
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {settingsSection === 'appearance' ? (
            <AppearanceSection />
          ) : settingsSection === 'chat' ? (
            <ChatDisplaySection />
          ) : settingsSection === 'models' ? (
            <SettingsPage width="wide">
              <ModelRolesSection />
            </SettingsPage>
          ) : settingsSection === 'advanced' ? (
            <AdvancedSection />
          ) : settingsSection === 'sessions' ? (
            <SessionsSection />
          ) : settingsSection === 'panels' ? (
            <RightPaneSection />
          ) : (
            <StatusLineSection />
          )}
        </div>
      </div>
    </div>
  )
}
