import { useEffect, useRef } from 'react'
import { useClearedAnnouncement } from '@/lib/use-cleared-announcement'
import { useCommandsStore, useDraftStore } from '@/state'
import type { SlashCommand } from '../../../shared/ipc'
import { parseSlashMenuState, rankSlashMenuCommands, type SlashMenuRow, type SlashMenuState } from './SlashMenu'
import { pruneDanglingChips, type PendingTextChip } from './attachments'

// Pure-ish composer glue -- the only side effects are the debounced live-region announcement and
// the draft-store writes a completed selection makes (#947).

// Stable reference so the zustand selector below never returns a fresh array when there is no
// match; a new `[]` literal every call breaks useSyncExternalStore's snapshot stability and causes
// an infinite re-render loop.
const EMPTY_COMMANDS: SlashCommand[] = []
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
  runBare?: boolean
  /**
   * True only when the caller (MessageInput's own Enter handler) has already confirmed the typed
   * subcommand query is an EXACT, case-insensitive match for `command.name` -- sends the completed
   * `/parent subcommand` AT ONCE.
   */
  sendImmediately?: boolean
}

export interface UseSlashMenuCompletionResult {
  slashMenuState: SlashMenuState | null
  slashMatches: SlashMenuRow[]
  showSlashMenu: boolean
  slashMenuKey: string | null
  slashMenuViewProps: { labelPrefix: string; ariaLabel: string; noMatchesText: string; hasQuery: boolean }
  slashAnnouncement: string
  handleSlashMenuSelect: (command: SlashCommand, options?: SlashMenuSelectOptions) => { sendText: string } | undefined
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
  const slashMenuViewProps = {
    labelPrefix: slashMenuState?.step === 'subcommand' ? '' : '/',
    ariaLabel: slashMenuState?.step === 'subcommand' ? `/${slashMenuState.parent.name} subcommands` : 'Slash commands',
    noMatchesText: slashMenuState?.step === 'subcommand' ? 'No matching subcommands' : 'No matching commands',
    hasQuery: (slashMenuState?.query ?? '') !== ''
  }

  const [slashAnnouncement, announceSlashResultCount] = useClearedAnnouncement()
  const lastAnnouncedTextRef = useRef<string | null>(null)
  useEffect(() => {
    if (!showSlashMenu) {
      lastAnnouncedTextRef.current = null
      return
    }
    const timer = setTimeout(() => {
      const liveText = useDraftStore.getState().bySession[sessionId]?.text ?? ''
      const liveCommands = useCommandsStore.getState().bySession[sessionId] ?? EMPTY_COMMANDS
      const liveState = parseSlashMenuState(liveText, liveCommands)
      if (liveState === null) return
      const liveMatches = rankSlashMenuCommands(liveState, liveCommands)
      let message: string
      if (liveState.step === 'subcommand') {
        const subcommandCount = liveState.query === '' ? liveMatches.length - 1 : liveMatches.length
        message =
          subcommandCount === 0
            ? 'No matching subcommands'
            : `/${liveState.parent.name}: ${subcommandCount} subcommand${subcommandCount === 1 ? '' : 's'}`
      } else {
        const shownCount = liveMatches.length
        message = `${shownCount} of ${liveCommands.length} command${liveCommands.length === 1 ? '' : 's'}`
      }
      if (message === lastAnnouncedTextRef.current) return
      lastAnnouncedTextRef.current = message
      announceSlashResultCount(message)
    }, 500)
    return () => clearTimeout(timer)
  }, [slashMenuKey, showSlashMenu, sessionId, announceSlashResultCount])

  function completeSlashText(nextText: string) {
    clearGhostState()
    useDraftStore.getState().setText(sessionId, nextText)
    setSlashDismissed(false)
    const prunedChips = pruneDanglingChips(nextText, textChips)
    if (prunedChips.length !== textChips.length) {
      announceChipRemoval(textChips.filter((chip) => !prunedChips.includes(chip)))
      useDraftStore.getState().setAttachments(sessionId, (prev) => ({ ...prev, textChips: prunedChips }))
    }
  }

  /**
   * A command with verified subcommands (issue #938 item 1) is left with a trailing space rather
   * than sent: the composer text now parses as that command's own subcommand step, so the menu
   * advances to it instead of closing.
   */
  function completeSlashCommand(command: SlashCommand) {
    completeSlashText(`/${command.name} `)
  }

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

  function handleSlashMenuKey(key: string, shiftKey: boolean, activeIndex: number): { sendText: string } | undefined | 'unhandled' {
    if (
      (key !== 'Enter' && key !== 'Tab') ||
      (key === 'Tab' && shiftKey) ||
      (key === 'Enter' && shiftKey) ||
      slashMatches.length === 0
    )
      return 'unhandled'
    if (slashMenuState?.step === 'subcommand' && slashMenuState.query.length > 0 && activeIndex === 0) {
      const exactMatch = slashMatches.find((row) => !row.isRunBare && row.command.name.toLowerCase() === slashMenuState.query.toLowerCase())
      if (exactMatch) return handleSlashMenuSelect(exactMatch.command, { sendImmediately: key === 'Enter' })
    }
    const match = slashMatches[Math.min(activeIndex, slashMatches.length - 1)]
    if (!match) return 'unhandled'
    return handleSlashMenuSelect(match.command, { runBare: match.isRunBare })
  }

  return { slashMenuState, slashMatches, showSlashMenu, slashMenuKey, slashMenuViewProps, slashAnnouncement, handleSlashMenuSelect, handleSlashMenuKey }
}
