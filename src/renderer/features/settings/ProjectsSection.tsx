// Settings > Projects (spec 054 FR-035, UI ruling from ui-architect-v3): the folder the Clone from
// GitHub dialog prefills. Saves immediately; Clear is always shown and disabled while unset.
import { FolderOpenIcon } from 'lucide-react'
import { SettingRow } from '@/components/settings/SettingRow'
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { Button } from '@/components/ui/button'
import { notify, useSettingsStore } from '@/state'

export function ProjectsSection() {
  const folder = useSettingsStore((state) => state.settings.defaultCloneFolder ?? null)
  const setSettings = useSettingsStore((state) => state.setSettings)

  async function save(path: string | null): Promise<void> {
    const result = await window.refract.settings.setDefaultCloneFolder(path)
    if (result.ok) setSettings(result.value)
    else notify(result.error)
  }

  async function handleBrowse(): Promise<void> {
    const picked = await window.refract.repositories.pickFolder()
    if (!picked.ok) {
      notify(picked.error)
      return
    }
    if (picked.value !== null) await save(picked.value)
  }

  return (
    <SettingsPage title="Projects" intro="Where Refract puts repositories you clone from GitHub.">
      <SettingsGroup title="Cloning">
        <SettingRow
          id="default-clone-folder"
          label="Default clone folder"
          description="The Clone from GitHub dialog starts with this folder."
          labelAsText
        >
          <div role="group" aria-labelledby="default-clone-folder-label" className="flex min-w-0 items-center gap-2">
            {folder ? (
              <span title={folder} className="min-w-0 max-w-64 truncate font-mono text-xs">
                {folder}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">Not set</span>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => void handleBrowse()}>
              <FolderOpenIcon aria-hidden />
              Browse
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={!folder} onClick={() => void save(null)}>
              Clear
            </Button>
          </div>
        </SettingRow>
      </SettingsGroup>
    </SettingsPage>
  )
}
