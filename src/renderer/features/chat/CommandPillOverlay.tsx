// FR-092, issue #1050 (UI polish, Decided Skippy, delegated by Stuart 2026-10-19, away mode):
// a recognised leading command or skill token gets a subtle accent pill, and the composer turns
// spellcheck off while it is showing. Reuses the composer's existing inert, scroll-synced,
// `aria-hidden` mirror overlay (`ChipOverlaySegments`/the ghost-text overlay, T103/FR-058) so the
// pill draws exactly over the token's own rendered position with no layout shift and no caret
// movement -- an invisible leading span (present only when the token itself doesn't start at the
// draft's own index 0) reserves the space before it, exactly as the chip overlay's own gap spans
// do, and an invisible trailing span reserves the space for everything after the token (the
// command's own arguments, which stay plain text -- decision 1). `MessageInput.tsx` is at its
// file-size cap (spec 001 working rule 11), so this logic lives in its own file.
import type { ReactNode, RefObject } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { classifySlashInvocation, parseSlashCommand } from '../../../shared/slash-commands'
import type { SlashCommand } from '../../../shared/ipc'

/** The character range of a recognised leading command/skill token in `text`, or `undefined`
 * when the draft does not start with one. Reuses `parseSlashCommand`/`classifySlashInvocation`
 * -- the exact same matching `chat.send`'s own refusal path already applies against the
 * composer's own `commands` list -- never a hard-coded copy of either the list or its matching
 * rules (decision 1). A command whose name the list recognises counts even when
 * `classifySlashInvocation` would refuse its own arguments (`'unsupported-arguments'`, e.g.
 * `/advisor dump`): the pill means "this command exists", not "this exact line will run" --
 * `'unknown-command'` (an unrecognised name, e.g. `/zzz`) is the only outcome with no pill. */
export interface RecognisedCommandToken {
  start: number
  end: number
}

export function findRecognisedCommandToken(text: string, commands: readonly SlashCommand[]): RecognisedCommandToken | undefined {
  const parsed = parseSlashCommand(text)
  if (!parsed) return undefined
  if (classifySlashInvocation(parsed, commands) === 'unknown-command') return undefined
  // `parseSlashCommand` itself trims LEADING whitespace before parsing (decision 1: "the very
  // start of the draft"): the token's own real character offsets in the untrimmed `text` start
  // after however much of that leading whitespace exists, never assumed to be a bare 0.
  const start = text.length - text.trimStart().length
  return { start, end: start + 1 + parsed.name.length }
}

/** `MessageInput.tsx`'s own integration point (working rule 11, file-size cap: that file has no
 * room for the ref/memo/scroll-sync wiring this needs, only this one call plus the render
 * call-site). Same scroll-sync reasoning as the ghost/chip overlays it sits beside: a freshly
 * mounted overlay div defaults to `scrollTop: 0`, which would misalign a token at the top of an
 * already-scrolled multi-line draft until the next real scroll event -- this re-syncs it the
 * instant a recognised token (re)appears. */
export function useCommandPillOverlay(text: string, commands: readonly SlashCommand[], textareaRef: RefObject<HTMLTextAreaElement | null>) {
  const commandToken = useMemo(() => findRecognisedCommandToken(text, commands), [text, commands])
  const commandPillOverlayRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (commandToken && commandPillOverlayRef.current && textareaRef.current) {
      commandPillOverlayRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [commandToken, textareaRef])
  return { commandToken, commandPillOverlayRef }
}

/** Decision 3's pill fill: NOT `--muted` as first drafted. Issue #610 already found
 * `--accent-text` does not clear 4.5:1 on `--muted` in every preset (TODO(#579),
 * `Markdown.tsx`), and a fresh measurement for this issue (`node scripts/check-theme-
 * contrast.mjs` against a scratch `accent-text`/`muted` pair) confirmed it still does not: Dark
 * 4.00:1, Obsidian 4.28:1 (both FAIL 4.5:1), Dark (high contrast) 6.60:1 (passes 4.5:1 but FAILS
 * this issue's own enhanced 7:1 ask). `--card` (decision 3's own named fallback) clears 4.5:1 in
 * every preset AND clears 7:1 in Dark (high contrast) (8.46:1) -- decided by measurement, not by
 * eye, per the issue's own instruction. `scripts/theme-contrast-pairs.mjs` already carries the
 * generic `accent-text`/`card` pair at 4.5:1; this story adds only the Dark (high contrast)
 * 7:1 pair on top of it. No border (decision 3); `rounded-sm` matches `--radius`'s own small
 * step, the same class `ChipOverlaySegments`' own pill uses; no padding, so the pill never widens
 * past the token's own glyph box (no layout shift); `[box-decoration-break:clone]` (same
 * reasoning as `ChipOverlaySegments`) repeats the fill/rounding cleanly on every visual line
 * fragment a wrapped token could cross. */
const PILL_CLASS = 'rounded-sm bg-card text-accent-text [box-decoration-break:clone]'

/** Renders the overlay's own children for one recognised token, in the same invisible-gap/
 * visible-content shape `ChipOverlaySegments` already uses: an invisible leading span (only when
 * the token doesn't start at index 0), the pill itself, and an invisible trailing span for
 * everything after it (the token's own arguments and any later lines) -- `text-accent-text`
 * paints fully opaque glyphs on top of the real textarea's own plain-coloured ones rendered at
 * the identical position underneath, the same masking trick the chip overlay's own doc comment
 * describes, so the real glyphs never show through. `data-command-pill-token` is a stable marker
 * for `scripts/verify-1050-command-pill.mjs` only -- no runtime reads it. */
export function CommandPillSegments({ text, token }: { text: string; token: RecognisedCommandToken }): ReactNode {
  return (
    <>
      {token.start > 0 && (
        <span key="gap-lead" className="invisible">
          {text.slice(0, token.start)}
        </span>
      )}
      <span key="pill" data-command-pill-token className={PILL_CLASS}>
        {text.slice(token.start, token.end)}
      </span>
      {token.end < text.length && (
        <span key="gap-trail" className="invisible">
          {text.slice(token.end)}
        </span>
      )}
    </>
  )
}
