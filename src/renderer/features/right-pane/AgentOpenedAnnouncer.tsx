import { useAgentAnnouncementStore } from '@/state/agent-announcement-store'

/** Polite live region for "Agent opened <panel>"; it never takes focus. Mount once. */
export function AgentOpenedAnnouncer() {
  const message = useAgentAnnouncementStore((s) => s.message)
  const serial = useAgentAnnouncementStore((s) => s.serial)
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      <span key={serial}>{message}</span>
    </div>
  )
}
