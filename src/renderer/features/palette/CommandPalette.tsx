import { useLayoutEffect, useEffect, useMemo, useRef, useState } from 'react'
import { Command, CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut, CommandStatus } from '@/components/ui/command'
import { useIssuesStore, usePullRequestsStore, useRepositoriesStore, useSessionsStore, useViewStore } from '@/state'
import { spokenChord } from './actionRegistry'
import { registerBuiltinActions } from './builtinActions'
import { PALETTE_SECTIONS, buildPaletteItems, rankPaletteItems, type PaletteItem } from './paletteItems'
import { usePaletteStore } from './paletteStore'
import { usePaletteConversations } from './usePaletteConversations'

/** The Ctrl+K palette: one fuzzy list over Sessions, Conversations, Actions, Settings, pull requests and issues. */
export function CommandPalette() {
  const open = usePaletteStore((state) => state.open)
  const setOpen = usePaletteStore((state) => state.setOpen)
  const invokerRef = useRef<HTMLElement | null>(null)
  const ranActionRef = useRef(false)

  useEffect(() => registerBuiltinActions(), [])

  // A layout effect so the invoker is read before Radix moves focus into the dialog.
  useLayoutEffect(() => {
    if (!open) return
    invokerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ranActionRef.current = false
  }, [open])

  function runItem(item: PaletteItem): void {
    ranActionRef.current = true
    setOpen(false)
    // After the dialog unmounts, so the action's own focus handling has the last word.
    requestAnimationFrame(() => {
      // Focus the invoker first so actions that compare against the focused element see where the user was.
      if (document.activeElement === null || document.activeElement === document.body) invokerRef.current?.focus()
      item.run()
      requestAnimationFrame(() => {
        const active = document.activeElement
        if (active === null || active === document.body || !active.isConnected) invokerRef.current?.focus()
      })
    })
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search Sessions, Conversations, actions, settings, pull requests and issues. Start with > for actions only."
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        if (!ranActionRef.current && invokerRef.current?.isConnected) invokerRef.current.focus()
      }}
    >
      <PaletteBody onRun={runItem} />
    </CommandDialog>
  )
}

// Mounted only while the dialog is open, so the store subscriptions cost nothing when it is closed.
function PaletteBody({ onRun }: { onRun(item: PaletteItem): void }) {
  const [query, setQuery] = useState('')
  const conversations = usePaletteConversations(true)
  const sessions = useSessionsStore((state) => state.sessions)
  const repositories = useRepositoriesStore((state) => state.repositories)
  const pullRequests = usePullRequestsStore((state) => state.items)
  const issues = useIssuesStore((state) => state.items)
  const view = useViewStore((state) => state.view)

  const ranked = useMemo(
    () => rankPaletteItems(buildPaletteItems(conversations), query),
    // `when()` reads store state at call time, so these dependencies are what trigger a re-read.
    [query, conversations, sessions, repositories, pullRequests, issues, view]
  )

  return (
    <Command shouldFilter={false} vimBindings={false} label="Command palette results">
      <CommandInput value={query} onValueChange={setQuery} placeholder="Search, or type > for actions" />
      <CommandStatus count={ranked.length} />
      <CommandList>
        {PALETTE_SECTIONS.map((section) => {
          const rows = ranked.filter((item) => item.section === section)
          if (rows.length === 0) return null
          return (
            <CommandGroup key={section} heading={section}>
              {rows.map((item) => (
                <CommandItem key={item.id} value={item.id} onSelect={() => onRun(item)}>
                  <span className="min-w-0 truncate">{item.label}</span>
                  {item.hint && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      <span className="sr-only">, </span>
                      {item.hint}
                    </span>
                  )}
                  {item.chord && (
                    <>
                      <CommandShortcut aria-hidden>{item.chord}</CommandShortcut>
                      <span className="sr-only">, {spokenChord(item.chord.split('+'))}</span>
                    </>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )
        })}
      </CommandList>
    </Command>
  )
}
