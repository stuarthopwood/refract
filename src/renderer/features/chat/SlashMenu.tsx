// The slash-command menu (contracts/ipc.md `chat.commands`/`commands:update`; FR-032, FR-033,
// FR-074, FR-075): shown above the message box while the composer's text parses as either step
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

/** A row the slash menu shows; `isRunBare` marks the synthetic "Run /<cmd>" row every
 * subcommand step gets as its own first row (issue #938 item 1, decided 2026-10-18, delegated by
 * Stuart): selecting it sends the bare parent command AT ONCE, restoring the pre-#938 "Enter,
 * Enter" muscle memory deliberately instead of blindly -- never present for the top-level step. */
export interface SlashMenuRow extends SlashCommandMatch {
  isRunBare?: boolean
}

/** A stable per-row key, shared between this module's own rendering and the composer's
 * `aria-activedescendant` computation (issue #938 item 1 gate round 1, Low: an id keyed on a
 * row's POSITION broke the moment the run-bare row shifted every real row down by one). Round 2
 * gate finding (Main, 2026-10-18, High): the literal string used here used to contain an actual
 * NUL byte (`'\0run-bare'`), which made Git treat this whole file as binary -- every PR review of
 * it showed "Bin NNN -> MMM bytes" instead of a real patch, and `ripgrep`/this repo's own `grep`
 * tool silently skip binary files entirely. `':run-bare'` is plain text and just as impossible for
 * a real command name to collide with (`SlashCommand.name` is never empty and never starts with
 * `:`). */
export function slashRowKey(row: SlashMenuRow): string {
  return row.isRunBare ? ':run-bare' : row.command.name
}

/** The ranked, filtered list the menu shows for a given parsed `state` (issue #947: every
 * command ranked by `rankSlashCommands`; issue #938 item 1: a subcommand step ranks the parent's
 * own pruned subcommand list, status-first on an empty query, with its own synthetic "Run
 * /<cmd>" row first -- but ONLY while the query is still empty, round 2 gate finding H, decided
 * 2026-10-18 by Skippy, delegated by Stuart: as soon as anything is typed after `/cmd `, the row
 * disappears and the list holds only real subcommand matches, so a partly typed subcommand can
 * never blind-fire the bare command via the stuck-at-index-0 row -- see
 * `useSlashMenuCompletion.ts`'s own exact-match shortcut for the complementary "typed the FULL
 * name" case). */
export function rankSlashMenuCommands(state: SlashMenuState, commands: readonly SlashCommand[]): SlashMenuRow[] {
  if (state.step === 'command') return rankSlashCommands(state.query, commands)
  const subcommands = state.query === '' ? orderSubcommandsForEmptyQuery(state.parent.subcommands!) : state.parent.subcommands!
  const ranked = rankSlashCommands(state.query, subcommands)
  if (state.query !== '') return ranked
  const runBare: SlashMenuRow = { command: state.parent, nameMatchRanges: [], isRunBare: true }
  return [runBare, ...ranked]
}

export interface SlashMenuProps {
  id: string
  commands: SlashMenuRow[]
  activeIndex: number
  /** Leading text before each row's own name (`/` for the top-level step, `''` for a subcommand
   * step, which already follows `/parent ` in the composer). Defaults to `/`. */
  labelPrefix?: string
  /** Defaults to "Slash commands"; a subcommand step names its own parent command instead, so
   * two stacked listboxes with the same accessible name are never ambiguous to assistive tech. */
  ariaLabel?: string
  /** Defaults to "No matching commands"; a subcommand step uses "No matching subcommands"
   * instead (issue #938 item 1, FR-075). */
  noMatchesText?: string
  /** Whether the caller's own query text is non-empty (round 2 gate finding M2, decided
   * 2026-10-18): the bare `/` list and an empty subcommand step (both effectively "no query yet")
   * must stay one line per row regardless of a row's own `nameMatchRanges` -- an empty query never
   * bolds anything on ANY row, so without this flag every row in those two cases would wrongly
   * show its full, possibly multi-line description (the "nothing bolded" rule below exists for a
   * genuine description-only match against a real, non-empty query, not for "no query at all").
   * Defaults to `true` for backward compatibility with any caller that does not pass it. */
  hasQuery?: boolean
  onSelect(command: SlashCommand, isRunBare?: boolean): void
  onActiveIndexChange(index: number): void
}

/** Stable id for a given row, keyed on `slashRowKey` (not position, gate round 1 Low above),
 * shared with MessageInput so it can set `aria-activedescendant` without either side guessing
 * the other's id scheme. */
export function slashOptionId(menuId: string, rowKey: string): string {
  return `${menuId}-option-${encodeURIComponent(rowKey)}`
}

/** Splits `name` into plain/bold runs per `ranges` (issue #947 decision 5): a matched span's own
 * characters render in `<b>`, everything else at normal weight, all inside one text node
 * container so the option's accessible name is never split into separate announcements. Gate
 * round 1 fix (Low): ranges are clamped into `[0, name.length]` first -- a match computed against
 * an alias or a stale name should never be able to slice outside the string it is actually
 * rendering against. */
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

  // Gate round 1 fix (Low): also re-settles when the LIST ITSELF changes (a fresh query whose
  // active row stays at index 0 numerically never changed `activeIndex`, but is a different row).
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, commands])

  if (commands.length === 0) {
    return (
      <div
        aria-hidden="true"
        className="absolute bottom-full left-0 z-10 mb-1 w-72 rounded-lg bg-popover p-2 text-sm text-muted-foreground shadow-md ring-1 ring-foreground/10"
      >
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
      className="absolute bottom-full left-0 z-10 mb-1 max-h-56 w-72 overflow-y-auto overflow-x-hidden rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
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
            // mousedown, not click: fires before the textarea blurs, so focus never leaves it.
            event.preventDefault()
            onSelect(match.command, match.isRunBare)
          }}
          className={cn(
            'flex cursor-default items-center justify-between gap-3 border-l-2 border-transparent px-2 py-1.5',
            index === activeIndex && 'border-l-active-indicator bg-accent text-accent-foreground'
          )}
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
