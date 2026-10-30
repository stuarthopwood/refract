import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'

export interface KeyboardShortcutsDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** Called on close; the caller restores focus since the dialog has no `Trigger`. */
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

// Lists only chords with a real handler; chords documented but unhandled (Ctrl+Shift+N, Ctrl+1..9, Ctrl+B, Ctrl+Shift+A, Ctrl+K) stay out.
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
    heading: 'Sessions',
    rows: [{ action: 'New session', keys: ['Ctrl', 'N'] }]
  },
  {
    heading: 'Pause',
    rows: [{ action: 'Resume the focused paused session', keys: ['Space'] }]
  },
  {
    heading: 'Chat pane',
    rows: [{ action: 'Close chat pane', keys: ['Ctrl', 'W'] }]
  },
  {
    heading: 'Right pane',
    rows: [{ action: 'Collapse or expand the right pane', keys: ['Ctrl', 'Shift', 'B'] }]
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

/** Read-only list of the supported keyboard shortcuts. */
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
              <h3 className="text-xs text-muted-foreground">{group.heading}</h3>
              <ul role="list" className="flex flex-col gap-2">
                {group.rows.map((row) => (
                  <li key={row.action} className="flex min-w-0 items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm">{row.action}</span>
                    <KbdGroup className="shrink-0">
                      {row.keys.map((key) => (
                        <Kbd key={key}>
                          {/* A lone ',' reads ambiguously to screen readers. */}
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
