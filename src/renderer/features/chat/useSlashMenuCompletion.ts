import { useEffect, useRef } from 'react'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { useCommandsStore, useDraftStore } from '@/state'
import type { SlashCommand } from '../../../shared/ipc'
import { parseSlashMenuState, rankSlashMenuCommands, type SlashMenuRow, type SlashMenuState } from './SlashMenu'
import { pruneDanglingChips, type PendingTextChip } from './attachments'

// Split out of MessageInput.tsx to stay within the 600-line file-size cap (scripts/check-file-
// size.mjs): issues #947 (fuzzy search, result-count announcement) and #938 item 1 (subcommand
// step). Pure-ish composer glue -- the only side effects are the debounced live-region
// announcement and the draft-store writes a completed selection makes.

// Stable reference so the zustand selector below never returns a fresh array when there is no
// match; a new `[]` literal every call breaks useSyncExternalStore's snapshot stability and
// causes an infinite re-render loop.
const EMPTY_COMMANDS: SlashCommand[] = []
// Same stable-reference reasoning as `EMPTY_COMMANDS` above, for the ranked-match list below.
const EMPTY_MATCHES: SlashMenuRow[] = []

export interface UseSlashMenuCompletionArgs {
  sessionId: string
  text: string
  commands: readonly SlashCommand[]
  slashDismissed: boolean
  setSlashDismissed: (dismissed: boolean) => void
  clearGhostState: () => void
  textChips: readonly PendingTextChip[]
  announceChipRemoval: (removed: readonly PendingTextChip[]) => void
}

export interface SlashMenuSelectOptions {
  /** True for the subcommand step's own synthetic "Run /<cmd>" row (issue #938 item 1, decided
   * 2026-10-18): sends the bare parent command AT ONCE regardless of how it was activated
   * (Enter, Tab, or a click) -- the whole point of a row literally labelled "Run". */
  runBare?: boolean
  /** True only when the caller (MessageInput's own Enter handler) has already confirmed the
   * typed subcommand query is an EXACT, case-insensitive match for `command.name` -- sends the
   * completed `/parent subcommand` AT ONCE. Never set for Tab: "Tab still completes" (decided
   * 2026-10-18) -- only Enter on an exact match sends. */
  sendImmediately?: boolean
}

export interface UseSlashMenuCompletionResult {
  slashMenuState: SlashMenuState | null
  slashMatches: SlashMenuRow[]
  showSlashMenu: boolean
  /** A stable string key for the parsed step, used both to reset the active row (component-
   * owned, since `slashActiveIndex` is used well beyond this hook) and to debounce the result-
   * count announcement below: distinct per PARENT command too for a subcommand step (issue #938
   * item 1), so switching from typing `/advisor` to its own subcommand step counts as a real
   * change even when both happen to read the same raw text. */
  slashMenuKey: string | null
  slashAnnouncement: string
  /** Routes a selection (mousedown, or an Enter/Tab the caller already resolved to a command) to
   * the right completion for whichever step is currently showing. Returns `{ sendText }` when
   * the caller must ALSO send that exact text immediately (the run-bare row, or an Enter on an
   * exact subcommand match, issue #938 item 1 decided 2026-10-18) -- `undefined` for an ordinary
   * completion that only fills the composer. */
  handleSlashMenuSelect: (command: SlashCommand, options?: SlashMenuSelectOptions) => { sendText: string } | undefined
  /** Keyboard Enter/Tab convenience wrapper around `handleSlashMenuSelect`, see its own doc
   * comment at the call site below. */
  handleSlashMenuKey: (key: string, shiftKey: boolean, activeIndex: number) => { sendText: string } | undefined | 'unhandled'
}

export function useSlashMenuCompletion({
  sessionId,
  text,
  commands,
  slashDismissed,
  setSlashDismissed,
  clearGhostState,
  textChips,
  announceChipRemoval
}: UseSlashMenuCompletionArgs): UseSlashMenuCompletionResult {
  const slashMenuState = parseSlashMenuState(text, commands)
  const slashMatches = slashMenuState !== null ? rankSlashMenuCommands(slashMenuState, commands) : EMPTY_MATCHES
  const showSlashMenu = slashMenuState !== null && !slashDismissed
  const slashMenuKey =
    slashMenuState === null ? null : slashMenuState.step === 'command' ? `c:${slashMenuState.query}` : `s:${slashMenuState.parent.name}:${slashMenuState.query}`

  // Issue #947 ("Announce the result count politely when it changes... debounced", mirroring
  // `SessionList.tsx`'s own search-result announcement): a fresh 500ms timer per real change to
  // `slashMenuKey`. Re-reads live state at fire time (same reasoning as that pattern) rather than
  // closing over this render's own `slashMatches`, so the debounce itself does not need that
  // array in its dependencies (a fresh `[]`/mapped array identity every render would otherwise
  // retrigger the timer on every keystroke, defeating the debounce).
  const [slashAnnouncement, announceSlashResultCount] = useClearedAnnouncement()
  // M1 (gate round 1): announces only when the COUNT itself actually changes -- `slashMenuKey`
  // changes on every keystroke, but many of those keystrokes narrow nothing (the same set of
  // commands still matches), and re-announcing an unchanged count on every debounce firing would
  // be noise, not news.
  const lastAnnouncedCountRef = useRef<number | null>(null)
  useEffect(() => {
    if (!showSlashMenu) return
    const timer = setTimeout(() => {
      const liveText = useDraftStore.getState().bySession[sessionId]?.text ?? ''
      const liveCommands = useCommandsStore.getState().bySession[sessionId] ?? EMPTY_COMMANDS
      const liveState = parseSlashMenuState(liveText, liveCommands)
      if (liveState === null) return
      const liveMatches = rankSlashMenuCommands(liveState, liveCommands)
      if (liveState.step === 'subcommand') {
        // The synthetic "Run /<cmd>" row is not itself a subcommand -- excluded from the count.
        const subcommandCount = liveMatches.length - 1
        if (subcommandCount === lastAnnouncedCountRef.current) return
        lastAnnouncedCountRef.current = subcommandCount
        announceSlashResultCount(subcommandCount === 0 ? 'No matching subcommands' : `/${liveState.parent.name}: ${subcommandCount} subcommand${subcommandCount === 1 ? '' : 's'}`)
        return
      }
      const shownCount = liveMatches.length
      if (shownCount === lastAnnouncedCountRef.current) return
      lastAnnouncedCountRef.current = shownCount
      announceSlashResultCount(`${shownCount} of ${liveCommands.length} command${liveCommands.length === 1 ? '' : 's'}`)
    }, 500)
    return () => clearTimeout(timer)
  }, [slashMenuKey, showSlashMenu, sessionId, announceSlashResultCount])

  /** Shared completion logic (issue #938 item 1 adds the subcommand step on top of this): fills
   * the box with `nextText` so it no longer parses as the CURRENT slash-menu step, which closes
   * or advances the menu purely by what the composer text now parses as (`parseSlashMenuState`
   * above) -- no separate step state needed. */
  function completeSlashText(nextText: string) {
    clearGhostState() // bypasses the normal onChange path too (#358/#359 remediation)
    useDraftStore.getState().setText(sessionId, nextText)
    setSlashDismissed(false)
    // Medium remediation (test-reviewer): this also bypasses onChange's own `pruneDanglingChips`
    // call the same way Enter-send and Esc-clear do -- without this a chip whose label no longer
    // appears in the draft stays pending indefinitely, and a stale pending label can wrongly count
    // as "already used" when a later paste tries to disambiguate against it (compounding the
    // Critical chip-collision remediation above).
    const prunedChips = pruneDanglingChips(nextText, textChips)
    if (prunedChips.length !== textChips.length) {
      announceChipRemoval(textChips.filter((chip) => !prunedChips.includes(chip)))
      useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, textChips: prunedChips }))
    }
  }

  /** Enter or Tab on a highlighted top-level slash command (FR-032). A command with verified
   * subcommands (issue #938 item 1) is left with a trailing space rather than sent: the composer
   * text now parses as that command's own subcommand step, so the menu advances to it instead of
   * closing. */
  function completeSlashCommand(command: SlashCommand) {
    completeSlashText(`/${command.name} `)
  }

  /** Enter or Tab on a highlighted subcommand (issue #938 item 1): completes the FULL
   * `/parent subcommand ` invocation, which closes the menu (a trailing space after the
   * subcommand no longer parses as an in-progress subcommand query). */
  function completeSubcommand(parent: SlashCommand, subcommand: SlashCommand) {
    completeSlashText(`/${parent.name} ${subcommand.name} `)
  }

  function handleSlashMenuSelect(command: SlashCommand, options?: SlashMenuSelectOptions): { sendText: string } | undefined {
    if (options?.runBare) {
      const sendText = `/${command.name}`
      completeSlashText(sendText)
      return { sendText }
    }
    if (slashMenuState?.step === 'subcommand') {
      completeSubcommand(slashMenuState.parent, command)
      if (options?.sendImmediately) {
        return { sendText: `/${slashMenuState.parent.name} ${command.name}` }
      }
      return undefined
    }
    completeSlashCommand(command)
    return undefined
  }

  /** Resolves a keyboard Enter/Tab against the row currently highlighted at `activeIndex`
   * (component-owned, see `slashMenuKey`'s own doc comment) and routes it through
   * `handleSlashMenuSelect` -- `'unhandled'` for any other key, an empty list, or Shift+Tab (gate
   * round 1 Low: left to its normal backward focus-movement behaviour, never captured here). */
  function handleSlashMenuKey(key: string, shiftKey: boolean, activeIndex: number): { sendText: string } | undefined | 'unhandled' {
    if ((key !== 'Enter' && key !== 'Tab') || (key === 'Tab' && shiftKey) || slashMatches.length === 0) return 'unhandled'
    const match = slashMatches[Math.min(activeIndex, slashMatches.length - 1)]
    if (!match) return 'unhandled'
    if (key === 'Tab') return handleSlashMenuSelect(match.command, { runBare: match.isRunBare })
    // Issue #938 item 1 (decided 2026-10-18): Enter on a subcommand typed out in FULL (an exact,
    // case-insensitive match for its own name, not just the current fuzzy-ranked top row) sends
    // the completed invocation at once instead of only filling the composer.
    const exactSubcommandMatch =
      !match.isRunBare && slashMenuState?.step === 'subcommand' && slashMenuState.query.length > 0 && slashMenuState.query.toLowerCase() === match.command.name.toLowerCase()
    return handleSlashMenuSelect(match.command, { runBare: match.isRunBare, sendImmediately: exactSubcommandMatch })
  }

  return { slashMenuState, slashMatches, showSlashMenu, slashMenuKey, slashAnnouncement, handleSlashMenuSelect, handleSlashMenuKey }
}
