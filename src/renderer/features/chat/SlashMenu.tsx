// The slash-command menu (contracts/ipc.md `chat.commands`/`commands:update`; FR-032, FR-033):
// shown above the message box while it starts with `/` and has no space yet. No shadcn
// `Command` (no `cmdk` dependency) in components/ui, so this is a small listbox built by hand.
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { SlashCommand } from '../../../shared/ipc'

/** The typed slash query (without the leading `/`), or null when the box is not showing one:
 * the text must start with `/` and contain no whitespace yet (FR-032: "When the user types `/`"). */
export function parseSlashQuery(text: string): string | null {
  if (!text.startsWith('/')) return null
  const rest = text.slice(1)
  if (/\s/.test(rest)) return null
  return rest
}

/** Matches by name or alias, case-insensitively, by prefix (an empty query matches everything). */
export function filterSlashCommands(query: string, commands: SlashCommand[]): SlashCommand[] {
  const needle = query.toLowerCase()
  return commands.filter(
    (command) =>
      command.name.toLowerCase().startsWith(needle) || (command.aliases ?? []).some((alias) => alias.toLowerCase().startsWith(needle))
  )
}

export interface SlashMenuProps {
  commands: SlashCommand[]
  activeIndex: number
  onSelect(command: SlashCommand): void
  onActiveIndexChange(index: number): void
}

export function SlashMenu({ commands, activeIndex, onSelect, onActiveIndexChange }: SlashMenuProps) {
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (commands.length === 0) {
    return (
      <div
        role="listbox"
        aria-label="Slash commands"
        className="absolute bottom-full left-0 z-10 mb-1 w-72 rounded-lg bg-popover p-2 text-sm text-muted-foreground shadow-md ring-1 ring-foreground/10"
      >
        No matching commands
      </div>
    )
  }

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-full left-0 z-10 mb-1 max-h-56 w-72 overflow-y-auto rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
    >
      {commands.map((command, index) => (
        <li
          key={command.name}
          role="option"
          aria-selected={index === activeIndex}
          data-active={index === activeIndex}
          onMouseEnter={() => onActiveIndexChange(index)}
          onMouseDown={(event) => {
            // mousedown, not click: fires before the textarea blurs, so focus never leaves it.
            event.preventDefault()
            onSelect(command)
          }}
          className={cn(
            'flex cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5',
            index === activeIndex && 'bg-accent text-accent-foreground'
          )}
        >
          <span className="shrink-0 font-medium">/{command.name}</span>
          <span className="truncate text-xs text-muted-foreground">{command.description}</span>
        </li>
      ))}
    </ul>
  )
}
