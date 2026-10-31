// The Settings screen (spec 004 FR-011 to FR-016; wave 2 spec 036): a flat left section list
// (`SettingsNav`) beside the chosen section's page. Every section builds from the shared
// `SettingsPage` / `SettingsGroup` / `SettingRow`, and focuses its own heading on mount, so a
// section change always lands on the new content (the nav button is never left holding focus).
// Reached via the profile menu's Settings item (spec 008) and the gear control in SessionList.tsx.
import { ArrowLeftIcon } from 'lucide-react'
import { focusSettingsEntry } from '@/lib/focus'
import { useEnterOnSwitch } from '@/components/useEnterOnSwitch'
import { useViewStore } from '@/state'
import { AppearanceSection } from './AppearanceSection'
import { ChatDisplaySection } from './ChatDisplaySection'
import { ModelRolesSection } from './ModelRolesSection'
import { AdvancedSection } from './AdvancedSection'
import { RightPaneSection } from './RightPaneSection'
import { SessionsSection } from './SessionsSection'
import { ProjectsSection } from './ProjectsSection'
import { SettingsBrand } from './SettingsBrand'
import { SettingsNav } from './SettingsNav'
import { StatusLineSection } from './StatusLineSection'
import { IconButton } from '@/components/IconButton'
import { PanelHeader } from '@/components/PanelHeader'

export function SettingsScreen() {
  const settingsSection = useViewStore((state) => state.settingsSection) ?? 'appearance'
  const sectionRef = useEnterOnSwitch(settingsSection, 'fade')
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
      <PanelHeader>
        <IconButton label="Back to chat" side="bottom" className="no-drag-region" onClick={handleBackToChat}>
          <ArrowLeftIcon aria-hidden />
        </IconButton>
        <SettingsBrand />
        <span aria-hidden className="text-sm text-muted-foreground">/</span>
        <h1 className="text-sm font-semibold">Settings</h1>
      </PanelHeader>
      <div className="flex min-h-0 flex-1">
        <SettingsNav active={settingsSection} onSelect={openSettings} />
        <div ref={sectionRef} className="min-h-0 flex-1 overflow-y-auto p-6">
          {settingsSection === 'appearance' ? (
            <AppearanceSection />
          ) : settingsSection === 'chat' ? (
            <ChatDisplaySection />
          ) : settingsSection === 'models' ? (
            <ModelRolesSection />
          ) : settingsSection === 'advanced' ? (
            <AdvancedSection />
          ) : settingsSection === 'sessions' ? (
            <SessionsSection />
          ) : settingsSection === 'projects' ? (
            <ProjectsSection />
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
