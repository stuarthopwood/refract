import { useEffect } from 'react'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { useCommandsStore, useDraftStore } from '@/state'
import type { SlashCommand } from '../../../shared/ipc'
import { parseSlashMenuState, rankSlashMenuCommands, type SlashCommandMatch, type SlashMenuState } from './SlashMenu'
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
const EMPTY_MATCHES: SlashCommandMatch[] = []

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

export interface UseSlashMenuCompletionResult {
  slashMenuState: SlashMenuState | null
  slashMatches: SlashCommandMatch[]
  showSlashMenu: boolean
  /** A stable string key for the parsed step, used both to reset the active row (component-
   * owned, since `slashActiveIndex` is used well beyond this hook) and to debounce the result-
   * count announcement below: distinct per PARENT command too for a subcommand step (issue #938
   * item 1), so switching from typing `/advisor` to its own subcommand step counts as a real
   * change even when both happen to read the same raw text. */
  slashMenuKey: string | null
  slashAnnouncement: string
  /** Routes a selection (mousedown, or an Enter/Tab the caller already resolved to a command) to
   * the right completion for whichever step is currently showing. */
  handleSlashMenuSelect: (command: SlashCommand) => void
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
  useEffect(() => {
    if (!showSlashMenu) return
    const timer = setTimeout(() => {
      const liveText = useDraftStore.getState().bySession[sessionId]?.text ?? ''
      const liveCommands = useCommandsStore.getState().bySession[sessionId] ?? EMPTY_COMMANDS
      const liveState = parseSlashMenuState(liveText, liveCommands)
      if (liveState === null) return
      const liveMatches = rankSlashMenuCommands(liveState, liveCommands)
      announceSlashResultCount(liveMatches.length === 0 ? 'No matching commands' : `${liveMatches.length} matching command${liveMatches.length === 1 ? '' : 's'}`)
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

  function handleSlashMenuSelect(command: SlashCommand) {
    if (slashMenuState?.step === 'subcommand') {
      completeSubcommand(slashMenuState.parent, command)
    } else {
      completeSlashCommand(command)
    }
  }

  return { slashMenuState, slashMatches, showSlashMenu, slashMenuKey, slashAnnouncement, handleSlashMenuSelect }
}
