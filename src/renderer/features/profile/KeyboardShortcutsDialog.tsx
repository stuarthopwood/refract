// Keyboard shortcuts (spec 008 FR-020, T023): a read-only list reachable from the profile menu.
// HONESTY RULE: lists ONLY a chord actually verified to have a working handler in this codebase
// (a keydown listener, a textarea default, or an Electron accelerator) -- never a chord
// docs/design/index.md's own "Keyboard" table documents that has no real handler behind it yet.
// See the "Six rows were removed" paragraph in docs/design/index.md for the full set of rows
// this codebase does NOT implement; this dialog is the one place that only ever shows what is
// really there.
import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'

export interface KeyboardShortcutsDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** Called on close (Esc, the X button, Done, or programmatically) -- the caller
   *  (ProfileItem.tsx) returns focus to the profile item's name button, the same explicit
   *  close-auto-focus every dialog here needs since none is given a `Trigger` (Radix's own
   *  default would otherwise drop focus to `<body>`, confirmed live earlier in this spec). */
  onCloseFocus?(): void
}

interface ShortcutRow {
  action: string
  keys: string[]
}

interface ShortcutGroup {
  heading: string
  rows: ShortcutRow[]
}

// Every row here was individually verified against its real handler before being listed
// (MessageInput.tsx, App.tsx, SessionList.tsx) -- see this task's own report for the full
// row-by-row verification table. A chord in docs/design/index.md's "Keyboard" table that is NOT listed
// here (Ctrl+Shift+N, Ctrl+1 to Ctrl+9, Ctrl+B, Ctrl+Shift+A, Ctrl+K) has no working
// handler yet (#429 trimmed the table itself to match); it is left out entirely rather than
// shown as a false promise. Ctrl+, (Open Settings, #395) and Ctrl+N (New session, #6's first
// slice) each moved from that list into a real row below now that a handler exists (App.tsx).
const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    heading: 'Message box',
    rows: [
      { action: 'Send message', keys: ['Enter'] },
      { action: 'Newline in message', keys: ['Shift', 'Enter'] },
      { action: 'Clear the message box', keys: ['Esc'] },
      { action: 'Stop the running turn', keys: ['Ctrl', 'Shift', 'X'] }
    ]
  },
  {
    // Issue #6 (keyboard shortcut set), first slice: its own heading, listed before "Chat
    // pane" -- creating a Session precedes using one.
    heading: 'Sessions',
    rows: [{ action: 'New session', keys: ['Ctrl', 'N'] }]
  },
  {
    // Issue #621 (close chat pane): its own heading, not folded into "Split view" below --
    // Ctrl+W closes the showing chat pane whether or not a split is open.
    heading: 'Chat pane',
    rows: [{ action: 'Close chat pane', keys: ['Ctrl', 'W'] }]
  },
  {
    heading: 'Split view',
    rows: [
      { action: 'Open a session in split view', keys: ['Ctrl', 'Click'] },
      { action: 'Move focus to the other pane', keys: ['Ctrl', 'Shift', '\\'] }
    ]
  },
  {
    heading: 'General',
    rows: [{ action: 'Open Settings', keys: ['Ctrl', ','] }]
  }
]

export function KeyboardShortcutsDialog({ open, onOpenChange, onCloseFocus }: KeyboardShortcutsDialogProps) {
  const doneRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="min-w-0 max-h-[min(560px,calc(100vh-4rem))] sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          doneRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onCloseFocus?.()
        }}
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>The shortcuts Refract supports today.</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4 overflow-y-auto">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.heading} className="flex min-w-0 flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">{group.heading}</h3>
              <ul role="list" className="flex flex-col gap-2">
                {group.rows.map((row) => (
                  <li key={row.action} className="flex min-w-0 items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-sm">{row.action}</span>
                    <KbdGroup className="shrink-0">
                      {row.keys.map((key) => (
                        <Kbd key={key}>
                          {/* Quality-gate remediation (PR #637 gate, optional a11y): a lone ','
                              glyph reads ambiguously to a screen reader (sometimes silent,
                              sometimes "comma" depending on the engine) -- spelling it out for
                              assistive tech while keeping the visible key-cap glyph unchanged. */}
                          {key === ',' ? (
                            <>
                              <span aria-hidden>,</span>
                              <span className="sr-only">comma</span>
                            </>
                          ) : (
                            key
                          )}
                        </Kbd>
                      ))}
                    </KbdGroup>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button ref={doneRef} onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
