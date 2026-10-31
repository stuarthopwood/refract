// Sidebar notice row for a downloaded update (issue #883, FR-034): "Refract <version> is ready"
// with an "Update now" action. Dismissal is per version and lasts until the app restarts, like
// the other rows; the footer badge and install-on-quit stay either way.
import { useEffect, useRef } from 'react'
import { useUpdateNow } from '@/features/updates/useUpdateNow'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { focusProfileItemName } from '@/lib/focus'
import { useAlertDismissStore, useUpdateStore } from '@/state'
import { AlertRow } from './AlertRow'

export function useUpdateRowShown(): string | null {
  const state = useUpdateStore((s) => s.state)
  const dismissedVersion = useAlertDismissStore((s) => s.updateDismissedVersion)
  if (state?.phase !== 'downloaded' || !state.availableVersion) return null
  return state.availableVersion === dismissedVersion ? null : state.availableVersion
}

export function UpdateAlertRow({ version }: { version: string }) {
  const rowRef = useRef<HTMLDivElement>(null)
  const actionRef = useRef<HTMLButtonElement>(null)
  const dismissUpdate = useAlertDismissStore((s) => s.dismissUpdate)
  const { requestUpdateNow, confirmDialog } = useUpdateNow(() => {
    if (actionRef.current?.isConnected) actionRef.current.focus()
    else focusProfileItemName()
  })

  useEffect(() => {
    useChatAreaAnnouncer.getState().announce(`Refract ${version} is ready to install`)
  }, [version])

  return (
    <>
      <AlertRow
        containerRef={rowRef}
        label={`Refract ${version} is ready`}
        wrapLabel
        actionRef={actionRef}
        actionLabel="Update now"
        actionAriaLabel="Restart and install the update now"
        onAction={requestUpdateNow}
        dismissAriaLabel="Dismiss update notice"
        onDismiss={() => {
          focusProfileItemName()
          dismissUpdate(version)
        }}
      />
      {confirmDialog}
    </>
  )
}
