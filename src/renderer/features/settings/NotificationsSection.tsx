// Issue #1666: Settings > Notifications. Both switches only affect the OS notification; in-app toasts stay silent.
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { SettingSwitchRow } from '@/components/SettingSwitchRow'
import { useSettingsStore } from '@/state'

export function NotificationsSection() {
  const sessionSounds = useSettingsStore((state) => state.settings.sessionNotificationSounds !== false)
  const setSessionSounds = useSettingsStore((state) => state.setSessionNotificationSounds)
  const alarmSounds = useSettingsStore((state) => state.settings.alarmSounds !== false)
  const setAlarmSounds = useSettingsStore((state) => state.setAlarmSounds)

  return (
    <SettingsPage
      title="Notifications"
      intro="Choose which Windows notifications make a sound. A muted notification still appears. Windows Do Not Disturb and the Windows sound setting for Refract still apply."
    >
      <SettingsGroup title="Sounds">
        <SettingSwitchRow
          id="session-notification-sounds"
          label="Session notification sounds"
          description="Play a sound once when a Session needs your input or finishes while Refract is in the background."
          checked={sessionSounds}
          onCheckedChange={(checked) => void setSessionSounds(checked)}
        />
        <SettingSwitchRow
          id="alarm-sounds"
          label="Alarm sounds"
          description="Loop the alarm sound when an Alarm fires, until you dismiss the notification."
          checked={alarmSounds}
          onCheckedChange={(checked) => void setAlarmSounds(checked)}
        />
      </SettingsGroup>
    </SettingsPage>
  )
}
