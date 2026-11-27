// Settings > Sessions > Conversation cleanup (#2161, FR-189/FR-190). Nothing runs automatically: each
// cleanup is previewed and then confirmed by hand; the log sweep only ever offers folders Refract can
// tie to a deleted Session.
import { SettingRow } from '@/components/settings/SettingRow'
import { SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingSwitchRow } from '@/components/SettingSwitchRow'
import { CleanupPreviewButton, type CleanupPreview } from '@/components/CleanupPreviewButton'
import { useSettingsStore } from '@/state'
import { DEFAULT_CONVERSATION_RETENTION, MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from '../../../shared/model'
import type { Result } from '../../../shared/ipc'
import { NumberUnitField } from './advanced/NumberUnitField'
import { retentionPreviewData, runSummary, sweepPreviewData, previewSummary, type CleanupPreviewData, type CleanupRunData } from './cleanupPreview'

function mapResult<T, U>(result: Result<T>, map: (value: T) => U): Result<U> {
  return result.ok ? { ok: true, value: map(result.value) } : result
}

function toPreview(data: CleanupPreviewData, noun: string): CleanupPreview {
  return {
    summary: previewSummary(data, noun),
    items: data.items.map((item) => ({ key: item.key, label: item.label, caption: item.detail, value: '' }))
  }
}

export function ConversationCleanupGroup() {
  const retention = useSettingsStore((state) => state.settings.conversationRetention ?? DEFAULT_CONVERSATION_RETENTION)
  const setRetention = useSettingsStore((state) => state.setConversationRetention)

  return (
    <SettingsGroup title="Conversation cleanup">
      <SettingSwitchRow
        id="conversation-retention-toggle"
        label="Enable old-Conversation cleanup"
        description="Off by default. Nothing is deleted automatically: turning this on only unlocks the preview below, and you confirm every deletion. Only Conversations not changed for the number of days below are listed, never the current one or one being written."
        checked={retention.enabled}
        onCheckedChange={(enabled) => void setRetention({ ...retention, enabled })}
      />
      <SettingRow id="conversation-retention-days" label="Keep Conversations for" description={`Between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days.`}>
        <NumberUnitField
          id="conversation-retention-days-input"
          labelId="conversation-retention-days-label"
          value={retention.days}
          unit="days"
          min={MIN_RETENTION_DAYS}
          max={MAX_RETENTION_DAYS}
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
          buttonLabel="Preview old Conversations…"
          title="Delete old Conversations?"
          listLabel="Conversations to delete"
          confirmLabel="Delete"
          disabled={!retention.enabled}
          describedBy="conversation-retention-run-description"
          load={async () => mapResult(await window.refract.conversations.retentionPreview(), (preview) => toPreview(retentionPreviewData(preview), 'Conversation'))}
          run={async () => mapResult(await window.refract.conversations.retentionRun(), (run: CleanupRunData) => runSummary(run, 'Conversation'))}
        />
      </SettingRow>
      <SettingRow
        id="session-log-sweep"
        label="Leftover Session logs"
        description="Removes agent log folders of Sessions Refract already deleted. Folders from other tools and repositories are left alone."
        labelAsText
      >
        <CleanupPreviewButton
          buttonLabel="Preview leftover logs…"
          title="Delete leftover Session logs?"
          listLabel="Log folders to delete"
          confirmLabel="Delete"
          describedBy="session-log-sweep-description"
          load={async () => mapResult(await window.refract.sessionLogs.sweepPreview(), (preview) => toPreview(sweepPreviewData(preview), 'log folder'))}
          run={async () => mapResult(await window.refract.sessionLogs.sweepRun(), (run: CleanupRunData) => runSummary(run, 'log folder'))}
        />
      </SettingRow>
    </SettingsGroup>
  )
}
