import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { getActions, spokenChord, type Chord } from '@/features/palette/actionRegistry'

export interface KeyboardShortcutsDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** Called on close; the caller restores focus since the dialog has no `Trigger`. */
  onCloseFocus?(): void
}

interface ShortcutRow {
  action: string
  chords: Chord[]
}

interface ShortcutGroup {
  heading: string
  rows: ShortcutRow[]
}

// Keys that are not actions: they only work inside one control, so no registry entry (or palette row) fits them.
const CONTEXTUAL_ROWS: Record<string, ShortcutRow[]> = {
  'Message box': [
    { action: 'Send message', chords: [['Enter']] },
    { action: 'Newline in message (continues a list)', chords: [['Shift', 'Enter']] },
    { action: 'Indent the line or selection', chords: [['Tab']] },
    { action: 'Outdent the line or selection', chords: [['Shift', 'Tab']] },
    { action: 'Switch Tab between indent and move focus', chords: [['Ctrl', 'M']] },
    { action: 'Clear the message box', chords: [['Esc']] }
  ],
  Pause: [{ action: 'Resume the focused paused session', chords: [['Space']] }],
  'Split view': [{ action: 'Open a session in split view', chords: [['Ctrl', 'Click']] }]
}

const GROUP_ORDER = ['Message box', 'Sessions', 'Pause', 'Chat pane', 'Right pane', 'Split view', 'General']

// Bound-chord rows are display metadata from the action registry; useChordDispatcher matches them.
function buildShortcutGroups(): ShortcutGroup[] {
  const rows = new Map<string, ShortcutRow[]>(Object.entries(CONTEXTUAL_ROWS).map(([heading, list]) => [heading, [...list]]))
  for (const action of getActions()) {
    if (!action.chord) continue
    const list = rows.get(action.group) ?? []
    list.push({ action: action.label, chords: action.aliasChord ? [action.chord, action.aliasChord] : [action.chord] })
    rows.set(action.group, list)
  }
  const headings = [...GROUP_ORDER.filter((heading) => rows.has(heading)), ...[...rows.keys()].filter((heading) => !GROUP_ORDER.includes(heading))]
  return headings.map((heading) => ({ heading, rows: rows.get(heading) ?? [] }))
}

/** Read-only list of the supported keyboard shortcuts. */
export function KeyboardShortcutsDialog({ open, onOpenChange, onCloseFocus }: KeyboardShortcutsDialogProps) {
  const doneRef = useRef<HTMLButtonElement>(null)
  const groups = open ? buildShortcutGroups() : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="min-w-0 max-h-[min(560px,calc(100vh-4rem))] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg"
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
        {/* Middle grid row is `minmax(0,1fr)`: the list shrinks to the window and scrolls; header and Done stay visible. */}
        <ScrollArea className="min-h-0" viewportProps={{ tabIndex: 0, role: 'region', 'aria-label': 'Keyboard shortcuts list' }}>
          <div className="flex min-w-0 flex-col gap-4 p-1 pr-2">
            {groups.map((group) => (
              <div key={group.heading} className="flex min-w-0 flex-col gap-2">
                <h3 className="text-xs text-muted-foreground">{group.heading}</h3>
                <ul className="flex flex-col gap-2">
                  {group.rows.map((row) => (
                    <li key={row.action} className="flex min-w-0 items-center justify-between gap-2">
                      <span className="min-w-0 text-sm">{row.action}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        {row.chords.map((chord, index) => (
                          <span key={chord.join('+')} className="flex items-center gap-2">
                            {index > 0 && <span className="text-xs text-muted-foreground">or</span>}
                            <KbdGroup aria-hidden>
                              {chord.map((key) => (
                                <Kbd key={key}>{key}</Kbd>
                              ))}
                            </KbdGroup>
                            <span className="sr-only">{spokenChord(chord)}</span>
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button ref={doneRef} variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
