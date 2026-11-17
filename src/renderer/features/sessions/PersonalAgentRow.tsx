import { useState } from 'react'
import { notify, useSessionsStore, useSplitStore } from '@/state'
import { Button } from '@/components/ui/button'
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { focusSessionPane, focusSessionsNav } from '@/lib/focus'
import { SessionRow } from './SessionRow'

// Matches the Session row's footprint so the placeholder and the real row line up.
const PLACEHOLDER_BUTTON_CLASS =
  'h-auto min-h-11 w-full justify-start rounded-none py-1 pl-6 pr-2 text-sm font-normal text-session-row-fg hover:bg-session-row-hover-bg dark:hover:bg-session-row-hover-bg'

/** Creates the Personal Agent on first use, then selects and starts it like an explicit new Session. */
async function launchPersonalAgent(): Promise<void> {
  useChatAreaAnnouncer.getState().announce('Starting My Agent')
  const result = await window.refract.sessions.openPersonalAgent()
  if (!result.ok) {
    notify(result.error)
    return
  }
  await useSessionsStore.getState().refresh()
  const id = result.value.id
  void useSessionsStore.getState().open(id, true)
  useSplitStore.getState().replaceFocused(id)
  // The placeholder unmounts on creation, so focus would otherwise drop to <body>.
  requestAnimationFrame(() => focusSessionPane(id) || focusSessionsNav())
}

/** The list's pinned first row: the Personal Agent Session once it exists, else a "My Agent" placeholder. */
export function PersonalAgentRow() {
  const session = useSessionsStore((state) => state.sessions.find((candidate) => candidate.kind === 'personal'))
  const [launching, setLaunching] = useState(false)
  if (session) {
    return (
      <ul aria-label="Personal Agent" className="flex flex-col gap-0">
        <SessionRow session={session} />
      </ul>
    )
  }
  return (
    <ul aria-label="Personal Agent" className="flex flex-col gap-0">
      <li data-choice-item className="relative w-full">
        <Button
          variant="ghost"
          data-choice-item
          aria-disabled={launching || undefined}
          onClick={() => {
            if (launching) return
            setLaunching(true)
            void launchPersonalAgent().finally(() => setLaunching(false))
          }}
          className={PLACEHOLDER_BUTTON_CLASS}
        >
          My Agent
        </Button>
      </li>
    </ul>
  )
}
