import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { SlashCommand } from '../../../shared/ipc'
import { rankSlashCommands, type SlashCommandMatch, type SlashMatchRange } from '../../../shared/slashCommandSearch'

export type { SlashCommandMatch } from '../../../shared/slashCommandSearch'

/** Step 1: */
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

function orderSubcommandsForEmptyQuery(subcommands: readonly SlashCommand[]): readonly SlashCommand[] {
  const statusIndex = subcommands.findIndex((sub) => sub.name === 'status')
  if (statusIndex <= 0) return subcommands
  const reordered = subcommands.slice()
  const [status] = reordered.splice(statusIndex, 1)
  reordered.unshift(status!)
  return reordered
}

/** A row the slash menu shows; `isRunBare` marks the synthetic "Run /<cmd>" row every */
export interface SlashMenuRow extends SlashCommandMatch {
  isRunBare?: boolean
}

/** A stable per-row key, shared between this module's own rendering and the composer's */
export function slashRowKey(row: SlashMenuRow): string {
  return row.isRunBare ? ':run-bare' : row.command.name
}

/** The ranked, filtered list the menu shows for a given parsed `state` (issue #947: */
export function rankSlashMenuCommands(state: SlashMenuState, commands: readonly SlashCommand[]): SlashMenuRow[] {
  if (state.step === 'command') return rankSlashCommands(state.query, commands)
  const subcommands = state.query === '' ? orderSubcommandsForEmptyQuery(state.parent.subcommands!) : state.parent.subcommands!
  const ranked = rankSlashCommands(state.query, subcommands)
  if (state.query !== '') return ranked
  const runBare: SlashMenuRow = { command: state.parent, nameMatchRanges: [], isRunBare: true }
  return [runBare, ...ranked]
}

export const COMPOSER_MENU_NOTICE_CLASS =
  'absolute bottom-full left-0 z-10 mb-1 w-72 rounded-lg bg-popover p-2 text-sm text-muted-foreground shadow-md ring-1 ring-elevated-edge'
export const COMPOSER_MENU_LIST_CLASS =
  'absolute bottom-full left-0 z-10 mb-1 max-h-56 w-72 overflow-y-auto overflow-x-hidden rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-elevated-edge'
export function composerMenuRowClass(active: boolean): string {
  return cn(
    'flex cursor-default items-center justify-between gap-2 border-l-2 border-transparent px-2 py-1',
    active && 'border-l-active-indicator bg-accent text-accent-foreground'
  )
}

export interface SlashMenuProps {
  id: string
  commands: SlashMenuRow[]
  activeIndex: number
  labelPrefix?: string
  ariaLabel?: string
  noMatchesText?: string
  hasQuery?: boolean
  onSelect(command: SlashCommand, isRunBare?: boolean): void
  onActiveIndexChange(index: number): void
}

/** Stable id for a given row, keyed on `slashRowKey` (not position, gate round 1 Low above), */
export function slashOptionId(menuId: string, rowKey: string): string {
  return `${menuId}-option-${encodeURIComponent(rowKey)}`
}

function renderMatchedName(name: string, ranges: readonly SlashMatchRange[]) {
  if (ranges.length === 0) return name
  const parts: Array<string | { bold: string }> = []
  let cursor = 0
  for (const [rawStart, rawEnd] of ranges) {
    const start = Math.max(0, Math.min(rawStart, name.length))
    const end = Math.max(start, Math.min(rawEnd, name.length))
    if (start > cursor) parts.push(name.slice(cursor, start))
    if (end > start) parts.push({ bold: name.slice(start, end) })
    cursor = Math.max(cursor, end)
  }
  if (cursor < name.length) parts.push(name.slice(cursor))
  return parts.map((part, index) => (typeof part === 'string' ? <span key={index}>{part}</span> : <b key={index}>{part.bold}</b>))
}

export function SlashMenu({
  id,
  commands,
  activeIndex,
  labelPrefix = '/',
  ariaLabel = 'Slash commands',
  noMatchesText = 'No matching commands',
  hasQuery = true,
  onSelect,
  onActiveIndexChange
}: SlashMenuProps) {
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, commands])

  if (commands.length === 0) {
    return (
      <div aria-hidden="true" className={COMPOSER_MENU_NOTICE_CLASS}>
        {noMatchesText}
      </div>
    )
  }

  return (
    <ul
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={ariaLabel}
      className={COMPOSER_MENU_LIST_CLASS}
    >
      {commands.map((match, index) => (
        <li
          key={slashRowKey(match)}
          id={slashOptionId(id, slashRowKey(match))}
          role="option"
          aria-selected={index === activeIndex}
          data-active={index === activeIndex}
          onMouseEnter={() => onActiveIndexChange(index)}
          onMouseDown={(event) => {
            event.preventDefault()
            onSelect(match.command, match.isRunBare)
          }}
          className={composerMenuRowClass(index === activeIndex)}
        >
          {match.isRunBare ? (
            <>
              {/* Round 2 gate finding L3 (decided 2026-10-18): a muted "Send now" hint plus a
                  `title` -- this row's own name alone ("Run /advisor") does not say what
                  activating it DOES, unlike every ordinary row, which shows its real description
                  in the same slot below. */}
              <span className="min-w-0 truncate font-normal" title={`Run /${match.command.name} now, without choosing a subcommand`}>
                {`Run /${match.command.name}`}
              </span>
              <span className="min-w-0 shrink-[1000] truncate text-xs text-muted-foreground">Send now</span>
            </>
          ) : (
            <>
              <span className="min-w-0 truncate font-normal" title={match.command.name}>
                {labelPrefix}
                {renderMatchedName(match.command.name, match.nameMatchRanges)}
              </span>
              {/* M3 (gate round 1, "your call, record it"): no bold ever applies to a description
                  (decision 5), so an empty `nameMatchRanges` is the ONLY signal this row carries
                  for "this did not match by name or alias" -- rather than add a second field just
                  to tell a genuine description-only match apart from an alias win with nothing to
                  bold, the simpler, uniform rule wins: any row with nothing bolded shows its full
                  description, never truncated, so the one case that actually needs the extra
                  context (a description-only hit) is never silently clipped. Round 2 gate finding
                  M2 (decided 2026-10-18): that rule only actually means something once there IS a
                  query to have matched against -- `hasQuery` gates it so the bare `/` list and an
                  empty subcommand step (every row's `nameMatchRanges` is empty there too, simply
                  because there is nothing yet to bold) stay one line per row like every other
                  step, instead of every row flaring open to its full description. */}
              <span
                className={cn(
                  'min-w-0 shrink-[1000] text-xs text-muted-foreground',
                  hasQuery && match.nameMatchRanges.length === 0 ? 'whitespace-normal' : 'truncate'
                )}
              >
                {match.command.description}
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}
