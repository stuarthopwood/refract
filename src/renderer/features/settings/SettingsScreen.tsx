// The Settings screen (spec 004 FR-011 to FR-016, data-model.md "Settings screen"): a
// left-section-list layout ("Session readout", spec 007's "Appearance", and issues #455's
// "Model roles" / #457's "Chat"), switching content without redesigning this screen
// (FR-015). Reached via the temporary gear control in SessionList.tsx (research.md decision 7)
// until spec 008's profile-item cog supersedes it.
import { useEffect, useRef } from 'react'
import { ActiveIndicatorBar } from '@/components/ActiveIndicatorBar'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ArrowLeftIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { focusSettingsEntry } from '@/lib/focus'
import { useSettingsStore, useViewStore } from '@/state'
import type { ReadoutKind } from '../../../shared/model'
import type { SettingsSectionId } from '../../state/view-store'
import { AppearanceSection } from './AppearanceSection'
import { ChatDisplaySection } from './ChatDisplaySection'
import { ModelRolesSection } from './ModelRolesSection'
import { OmpSection } from './OmpSection'
import { RightPaneSection } from './RightPaneSection'
import { SessionsSection } from './SessionsSection'

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
  { kind: 'todo-progress', label: 'Todo progress', description: "How many of the agent's current tasks are done." },
  {
    kind: 'current-work',
    label: 'Show current work above the composer',
    description: 'A one-line banner of what the agent is doing while a turn runs or it needs you.'
  }
]

interface SettingsSectionDescriptor {
  id: SettingsSectionId
  label: string
}

const SECTIONS: SettingsSectionDescriptor[] = [
  { id: 'session-readout', label: 'Session readout' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'model-roles', label: 'Model roles' },
  { id: 'chat', label: 'Chat' },
  { id: 'right-pane', label: 'Right pane' },
  { id: 'omp', label: 'OMP' }
]

export function SettingsScreen() {
  const settingsSection = useViewStore((state) => state.settingsSection) ?? 'session-readout'
  const openChat = useViewStore((state) => state.openChat)
  const openSettings = useViewStore((state) => state.openSettings)
  const sessionReadout = useSettingsStore((state) => state.settings.sessionReadout)
  const setReadoutVisibility = useSettingsStore((state) => state.setReadoutVisibility)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // High remediation (a11y): the Settings entry point (SessionList.tsx's gear button) unmounts
  // the instant this screen shows (App.tsx swaps the whole main area on `view`), and nothing
  // here claimed focus -- it silently dropped to `<body>` on every entry. Focusing this screen's
  // own heading (already a real `<h2>`, `tabIndex={-1}` so it accepts programmatic focus without
  // joining the Tab order) lands keyboard/screen-reader users somewhere meaningful instead.
  // Spec 007: now that this screen switches between two LIVE sections without unmounting
  // itself, re-focus the heading on every section change too, not only the screen's own first
  // mount -- otherwise clicking "Appearance" in the nav (or back to "Session readout") left
  // focus sitting on whichever nav button was clicked instead of landing on the new section's
  // content, same gap the original effect already existed to avoid for the screen's own entry.
  useEffect(() => {
    headingRef.current?.focus()
  }, [settingsSection])

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
        <span className="text-sm font-medium">Settings</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" className="w-48 shrink-0 overflow-y-auto border-r border-divider p-2">
          <ul className="flex flex-col gap-1">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  aria-current={section.id === settingsSection ? 'page' : undefined}
                  onClick={() => openSettings(section.id)}
                  // Issue #1122: `relative` anchors the new shared bar below; `data-choice-item`
                  // joins the square-choice selector (globals.css) -- the unlayered rule there
                  // overrides this button's own `rounded-md` regardless of source order.
                  // Gate round 1 fix (code/a11y, two reviewers, pixel-measured in dark-03): the
                  // native button's own `border border-transparent` defaults to
                  // `background-clip: border-box`, which left a 1px band between the fill and
                  // the bar at the row's own top/bottom edges -- `bg-clip-padding` clips the
                  // fill to the padding box instead, flush with the bar. Fill is now the shared
                  // `bg-accent`/`text-accent-foreground` (not `bg-muted`), matching every other
                  // main-content selected row (components.md).
                  data-choice-item
                  className={cn(
                    'relative block w-full rounded-md border border-transparent bg-clip-padding px-2 py-1 text-left text-sm outline-none',
                    'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
                    // Forced colours strips the box-shadow ring and the transparent border, so
                    // draw a real outline there (same pattern as SessionList.tsx's Clear filter).
                    'forced-colors:focus-visible:outline-solid forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-[-2px]',
                    section.id === settingsSection ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  )}
                >
                  {/* Issue #1122: every other persistent selected surface gets this bar -- the
                      Settings nav never had one at all. */}
                  {section.id === settingsSection && <ActiveIndicatorBar />}
                  {section.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {settingsSection === 'appearance' ? (
            <AppearanceSection />
          ) : settingsSection === 'model-roles' ? (
            <ModelRolesSection />
          ) : settingsSection === 'chat' ? (
            <ChatDisplaySection />
          ) : settingsSection === 'right-pane' ? (
            <RightPaneSection />
          ) : settingsSection === 'omp' ? (
            <OmpSection />
          ) : settingsSection === 'sessions' ? (
            <SessionsSection />
          ) : (
            <>
              <h2 ref={headingRef} tabIndex={-1} className="mb-1 text-base font-semibold outline-none">
                Session readout
              </h2>
              <p className="mb-4 text-sm text-muted-foreground">
                Choose which readouts show in the chip row above the message box, and whether the current-work line shows above it, for every open Session.
              </p>
              <div className="flex flex-col divide-y divide-divider">
                {READOUT_TOGGLES.map((toggle) => {
                  const id = `readout-toggle-${toggle.kind}`
                  return (
                    <div key={toggle.kind} className="flex items-center justify-between gap-4 py-4">
                      <label htmlFor={id} className="flex flex-col gap-1">
                        <span className="text-sm">{toggle.label}</span>
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
            </>
          )}
        </div>
      </div>
    </div>
  )
}
