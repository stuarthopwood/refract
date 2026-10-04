// The Settings screen (spec 004 FR-011 to FR-016, data-model.md "Settings screen"): a
// left-section-list layout, one section today ("Session readout"); spec 007 adds "appearance"
// later without redesigning this screen (FR-015). Reached via the temporary gear control in
// SessionList.tsx (research.md decision 7) until spec 008's profile-item cog supersedes it.
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ArrowLeftIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { focusSettingsEntry } from '@/lib/focus'
import { useSettingsStore, useViewStore } from '@/state'
import type { ReadoutKind } from '../../../shared/model'
import type { SettingsSectionId } from '../../state/view-store'

interface ReadoutToggleDescriptor {
  kind: ReadoutKind
  label: string
  description: string
}

// FR-012: every ReadoutKind, in the chip row's own order.
const READOUT_TOGGLES: ReadoutToggleDescriptor[] = [
  { kind: 'changes', label: 'Changes', description: "Files changed and lines added or removed against the Base branch." },
  {
    kind: 'context-usage',
    label: 'Context window usage',
    description: "Tokens used out of the model's context window, with a warning once it nears the limit."
  },
  { kind: 'turn-time', label: 'Turn time', description: 'Elapsed time while a turn is running.' },
  { kind: 'current-time', label: 'Current time', description: 'The current time of day, updating at the top of each minute.' },
  { kind: 'pull-request', label: 'Pull request', description: "The open pull request for the Session's branch, if any." },
  { kind: 'subagents', label: 'Subagents', description: 'How many subagents are running or finished for the current turn.' },
  { kind: 'todo-progress', label: 'Todo progress', description: "How many of the agent's current tasks are done." }
]

interface SettingsSectionDescriptor {
  id: SettingsSectionId
  label: string
}

const SECTIONS: SettingsSectionDescriptor[] = [{ id: 'session-readout', label: 'Session readout' }]

export function SettingsScreen() {
  const settingsSection = useViewStore((state) => state.settingsSection) ?? 'session-readout'
  const openChat = useViewStore((state) => state.openChat)
  const sessionReadout = useSettingsStore((state) => state.settings.sessionReadout)
  const setReadoutVisibility = useSettingsStore((state) => state.setReadoutVisibility)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // High remediation (a11y): the Settings entry point (SessionList.tsx's gear button) unmounts
  // the instant this screen shows (App.tsx swaps the whole main area on `view`), and nothing
  // here claimed focus -- it silently dropped to `<body>` on every entry. Focusing this screen's
  // own heading (already a real `<h2>`, `tabIndex={-1}` so it accepts programmatic focus without
  // joining the Tab order) lands keyboard/screen-reader users somewhere meaningful instead.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

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
      <div className="drag-region flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <Button
          variant="ghost"
          size="icon"
          className="no-drag-region size-7"
          aria-label="Back to chat"
          onClick={handleBackToChat}
        >
          <ArrowLeftIcon aria-hidden className="size-4" />
        </Button>
        <span className="text-sm font-semibold">Settings</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" className="w-48 shrink-0 overflow-y-auto border-r p-2">
          <ul className="flex flex-col gap-0.5">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <span
                  aria-current={section.id === settingsSection ? 'page' : undefined}
                  className={cn(
                    'block w-full rounded-md px-2 py-1.5 text-left text-sm',
                    section.id === settingsSection ? 'bg-muted font-medium' : 'text-muted-foreground'
                  )}
                >
                  {section.label}
                </span>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <h2 ref={headingRef} tabIndex={-1} className="mb-1 text-base font-semibold outline-none">
            Session readout
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Choose which readouts show in the chip row above the message box, for every open Session.
          </p>
          <div className="flex flex-col divide-y divide-border">
            {READOUT_TOGGLES.map((toggle) => {
              const id = `readout-toggle-${toggle.kind}`
              return (
                <div key={toggle.kind} className="flex items-center justify-between gap-4 py-3">
                  <label htmlFor={id} className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{toggle.label}</span>
                    <span className="text-xs text-muted-foreground">{toggle.description}</span>
                  </label>
                  <Switch
                    id={id}
                    checked={sessionReadout[toggle.kind]}
                    onCheckedChange={(checked) => void setReadoutVisibility(toggle.kind, checked)}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
