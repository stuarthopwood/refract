// Settings > Sessions > Conversation cleanup (#2161, FR-189/FR-190). Retention is off by default and
// previews before it deletes; the log sweep only ever offers folders Refract can tie to a deleted Session.
import { SettingRow } from '@/components/settings/SettingRow'
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingSwitchRow } from '@/components/SettingSwitchRow'
import { useSettingsStore } from '@/state'
import { DEFAULT_CONVERSATION_RETENTION } from '../../../shared/model'
import type { Result } from '../../../shared/ipc'
import { NumberUnitField } from './advanced/NumberUnitField'
import { CleanupPreviewButton } from './CleanupPreviewButton'
import { retentionPreviewData, sweepPreviewData, type CleanupPreviewData } from './cleanupPreview'

const MIN_DAYS = 1
const MAX_DAYS = 3650

function mapResult<T>(result: Result<T>, map: (value: T) => CleanupPreviewData): Result<CleanupPreviewData> {
  return result.ok ? { ok: true, value: map(result.value) } : result
}

export function ConversationCleanupGroup() {
  const retention = useSettingsStore((state) => state.settings.conversationRetention ?? DEFAULT_CONVERSATION_RETENTION)
  const setRetention = useSettingsStore((state) => state.setConversationRetention)

  return (
    <SettingsGroup title="Conversation cleanup">
      <SettingSwitchRow
        id="conversation-retention-toggle"
        label="Delete old Conversations automatically"
        description="Off by default. Removes Conversations not changed for the number of days below, never the current one or one being written. Use Preview and delete to see what goes first."
        checked={retention.enabled}
        onCheckedChange={(enabled) => void setRetention({ ...retention, enabled })}
      />
      <SettingRow id="conversation-retention-days" label="Keep Conversations for" description="Between 1 and 3650 days.">
        <NumberUnitField
          id="conversation-retention-days-input"
          labelId="conversation-retention-days-label"
          value={retention.days}
          unit="days"
          min={MIN_DAYS}
          max={MAX_DAYS}
          disabled={!retention.enabled}
          onCommit={(days) => setRetention({ ...retention, days })}
        />
      </SettingRow>
      <SettingRow
        id="conversation-retention-run"
        label="Old Conversations"
        description={retention.enabled ? `Lists the Conversations older than ${retention.days} days before anything is deleted.` : 'Turn on the setting above to preview.'}
        labelAsText
      >
        <CleanupPreviewButton
          buttonLabel="Preview and delete…"
          title="Delete old Conversations?"
          noun="Conversation"
          confirmLabel="Delete"
          disabled={!retention.enabled}
          describedBy="conversation-retention-run-description"
          load={async () => mapResult(await window.refract.conversations.retentionPreview(), retentionPreviewData)}
          run={() => window.refract.conversations.retentionRun()}
        />
      </SettingRow>
      <SettingRow
        id="session-log-sweep"
        label="Leftover Session logs"
        description="Removes agent log folders of Sessions Refract already deleted. Folders from other tools and repositories are left alone."
        labelAsText
      >
        <CleanupPreviewButton
          buttonLabel="Preview and delete…"
          title="Delete leftover Session logs?"
          noun="log folder"
          confirmLabel="Delete"
          describedBy="session-log-sweep-description"
          load={async () => mapResult(await window.refract.sessionLogs.sweepPreview(), sweepPreviewData)}
          run={() => window.refract.sessionLogs.sweepRun()}
        />
      </SettingRow>
    </SettingsGroup>
  )
}
