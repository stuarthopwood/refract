// The slash-command menu (contracts/ipc.md `chat.commands`/`commands:update`; FR-032, FR-033,
// FR-072, FR-073): shown above the message box while the composer's text parses as either step
// below. No shadcn `Command` (no `cmdk` dependency) in components/ui, so this is a small listbox
// built by hand.
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { SlashCommand } from '../../../shared/ipc'
import { rankSlashCommands, type SlashCommandMatch, type SlashMatchRange } from '../../../shared/slashCommandSearch'

export type { SlashCommandMatch } from '../../../shared/slashCommandSearch'

/** Step 1: typing `/partial` with no space yet (FR-032: "When the user types `/`"). Step 2
 * (issue #938 item 1): one space after a RECOGNISED command that has verified subcommands
 * (`command.subcommands`, already pruned to the verified set by `filterSupportedCommands`),
 * with no further space yet -- the allowed subcommands become the menu's own next step, so
 * `/advisor` followed by Enter does not blindly send the bare command. Any other shape (a space
 * after an unrecognised name, or a name with no subcommands, or a second space) closes the menu
 * entirely, exactly as a bare space always has. */
export type SlashMenuState =
  | { step: 'command'; query: string }
  | { step: 'subcommand'; parent: SlashCommand; query: string }

export function parseSlashMenuState(text: string, commands: readonly SlashCommand[]): SlashMenuState | null {
  if (!text.startsWith('/')) return null
  const rest = text.slice(1)
  const spaceIndex = rest.search(/\s/)
  if (spaceIndex === -1) return { step: 'command', query: rest }
  const name = rest.slice(0, spaceIndex)
  const afterSpace = rest.slice(spaceIndex + 1)
  if (/\s/.test(afterSpace)) return null // a second space: this invocation is already complete
  const parent = commands.find((command) => command.name === name || (command.aliases ?? []).includes(name))
  if (!parent || !parent.subcommands || parent.subcommands.length === 0) return null
  return { step: 'subcommand', parent, query: afterSpace }
}

/** Issue #938 item 1 ("status first"): with nothing typed yet for the subcommand step, `status`
 * (present on every session-scoped on/off/status command, and read-only) leads the list; every
 * other subcommand keeps its own existing order. A non-empty query's own fuzzy ranking already
 * puts the best match first regardless, so this reordering only ever matters for the empty-query
 * case (`rankSlashCommands`' empty-query shape is a stable pass-through of its input order). */
function orderSubcommandsForEmptyQuery(subcommands: readonly SlashCommand[]): readonly SlashCommand[] {
  const statusIndex = subcommands.findIndex((sub) => sub.name === 'status')
  if (statusIndex <= 0) return subcommands
  const reordered = subcommands.slice()
  const [status] = reordered.splice(statusIndex, 1)
  reordered.unshift(status!)
  return reordered
}

/** The ranked, filtered list the menu shows for a given parsed `state` (issue #947: every
 * command ranked by `rankSlashCommands`; issue #938 item 1: a subcommand step ranks the parent's
 * own pruned subcommand list, status-first on an empty query). */
export function rankSlashMenuCommands(state: SlashMenuState, commands: readonly SlashCommand[]): SlashCommandMatch[] {
  if (state.step === 'command') return rankSlashCommands(state.query, commands)
  const subcommands = state.query === '' ? orderSubcommandsForEmptyQuery(state.parent.subcommands!) : state.parent.subcommands!
  return rankSlashCommands(state.query, subcommands)
}

export interface SlashMenuProps {
  id: string
  commands: SlashCommandMatch[]
  activeIndex: number
  /** Leading text before each row's own name (`/` for the top-level step, `''` for a subcommand
   * step, which already follows `/parent ` in the composer). Defaults to `/`. */
  labelPrefix?: string
  /** Defaults to "Slash commands"; a subcommand step names its own parent command instead, so
   * two stacked listboxes with the same accessible name are never ambiguous to assistive tech. */
  ariaLabel?: string
  onSelect(command: SlashCommand): void
  onActiveIndexChange(index: number): void
}

/** Stable id for a given option, shared with MessageInput so it can set `aria-activedescendant`
 * without either side guessing the other's id scheme. */
export function slashOptionId(menuId: string, index: number): string {
  return `${menuId}-option-${index}`
}

/** Splits `name` into plain/bold runs per `ranges` (issue #947 decision 5): a matched span's own
 * characters render in `<b>`, everything else at normal weight, all inside one text node
 * container so the option's accessible name is never split into separate announcements. */
function renderMatchedName(name: string, ranges: readonly SlashMatchRange[]) {
  if (ranges.length === 0) return name
  const parts: Array<string | { bold: string }> = []
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(name.slice(cursor, start))
    parts.push({ bold: name.slice(start, end) })
    cursor = end
  }
  if (cursor < name.length) parts.push(name.slice(cursor))
  return parts.map((part, index) => (typeof part === 'string' ? <span key={index}>{part}</span> : <b key={index}>{part.bold}</b>))
}

export function SlashMenu({ id, commands, activeIndex, labelPrefix = '/', ariaLabel = 'Slash commands', onSelect, onActiveIndexChange }: SlashMenuProps) {
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (commands.length === 0) {
    return (
      <div
        aria-hidden="true"
        className="absolute bottom-full left-0 z-10 mb-1 w-72 rounded-lg bg-popover p-2 text-sm text-muted-foreground shadow-md ring-1 ring-foreground/10"
      >
        No matching commands
      </div>
    )
  }

  return (
    <ul
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={ariaLabel}
      className="absolute bottom-full left-0 z-10 mb-1 max-h-56 w-72 overflow-y-auto overflow-x-hidden rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
    >
      {commands.map((match, index) => (
        <li
          key={match.command.name}
          id={slashOptionId(id, index)}
          role="option"
          aria-selected={index === activeIndex}
          data-active={index === activeIndex}
          onMouseEnter={() => onActiveIndexChange(index)}
          onMouseDown={(event) => {
            // mousedown, not click: fires before the textarea blurs, so focus never leaves it.
            event.preventDefault()
            onSelect(match.command)
          }}
          className={cn(
            'flex cursor-default items-center justify-between gap-3 border-l-2 border-transparent px-2 py-1.5',
            index === activeIndex && 'border-l-active-indicator bg-accent text-accent-foreground'
          )}
        >
          <span className="shrink-0 font-medium">
            {labelPrefix}
            {renderMatchedName(match.command.name, match.nameMatchRanges)}
          </span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{match.command.description}</span>
        </li>
      ))}
    </ul>
  )
}
