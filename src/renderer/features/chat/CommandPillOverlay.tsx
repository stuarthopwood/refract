// FR-092, issue #1050 (UI polish, Decided Skippy, delegated by Stuart 2026-10-19, away mode):
// a recognised leading command or skill token gets a subtle accent pill, and the composer turns
// spellcheck off while it is showing.
//
// Gate round 1 HIGH remediation (Code/Test/A11y/UI, all four independently): the ORIGINAL design
// painted an opaque pill overlay ON TOP of the real textarea (the same inert-mirror shape the
// ghost-text/chip overlays already use) -- this hides the real caret, the native selection
// highlight and the IME composition underline for any character inside the pilled token
// (confirmed live: the caret at offset 3 in `02-pill-btw.png` was gone). Fixed with the standard
// "highlight-within-textarea" technique instead: `CommandPillOverlay` below sits UNDER the real
// textarea and renders the WHOLE draft visibly -- the recognised token as the pill, everything
// else in plain `--foreground` text; `MessageInput.tsx`'s own `<textarea>` goes `relative z-[1]
// [-webkit-text-fill-color:transparent] caret-foreground selection:bg-composer-selection-bg
// selection:[-webkit-text-fill-color:...]` ONLY while a token is present
// (`COMMAND_PILL_TEXTAREA_CLASS` below, full reasoning there): its own glyphs become invisible
// (letting this mirror's coloured text show through underneath), but the native caret (an
// explicit `caret-color`, independent of text colour), the native selection highlight (a real
// `::selection` background now painted, gate round 3 HIGH fix: the round-1/2 cut only re-
// asserted `color`, which left the highlight invisible) and the real `color` (gate round 3 HIGH
// fix, IME: masking moved off `color` onto `-webkit-text-fill-color` so an IME composition
// underline, drawn in `currentColor`, stays visible) all keep rendering on the REAL textarea, on
// top of this mirror, exactly as before. With no recognised token the textarea keeps its
// ordinary opaque rendering and this component renders nothing -- byte-identical to the
// pre-#1050 composer. Gate round 3 CRITICAL fix: the composer's Send/Stop button container now
// carries its own `z-[3]`, above this textarea's `z-[1]` and the ghost-text/chip mirrors' `z-
// [2]` -- it used to have no z-index at all, so this textarea's own stacking context painted
// over it while a pill showed, making Send/Stop unclickable (`COMMAND_PILL_TEXTAREA_CLASS`'s own
// comment has the full stacking order).
import type { ReactNode, RefObject } from 'react'
import { useLayoutEffect, useMemo, useRef } from 'react'
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

/** Shared box-model-matching classes for every inert composer mirror (the ghost-text overlay,
 * the pending-text-chip overlay, and this pill) -- one constant instead of three verbatim
 * copies, so a future padding/font change can never silently drift one mirror out of alignment
 * with the others. `[scrollbar-gutter:stable]` (gate round 1 HIGH remediation, item 4): without
 * it, a mirror's own line-wrapping only matches the textarea's own while NO scrollbar is shown --
 * the instant a long draft actually scrolls, the real textarea's content width shrinks by the
 * scrollbar's own width while an un-reserved mirror keeps wrapping at the full width, drifting
 * every mirror out from under the real glyphs on any line past that point. `MessageInput.tsx`'s
 * own `<textarea>` reserves the same gutter unconditionally (not only while a pill shows) so the
 * two widths always match, pill or no pill. */
export const COMPOSER_MIRROR_CLASS =
  'pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2.5 py-2 pr-20 text-base text-foreground [scrollbar-gutter:stable] md:text-sm'

/** Decision 3's pill colours: two INDEPENDENT dedicated tokens (gate round 2 remediation --
 * round 1's single `--card`-or-`--muted`-aliased fill, paired with `--accent-text` directly, is
 * superseded). Round 1 proved no single existing colour clears both the accent-text contrast
 * floor (4.5:1, 7:1 in Dark high contrast) AND the gate's own "visibly distinct from the
 * composer surface" floor (>=1.4:1 against the effective composer backdrop) in Dark/Obsidian/
 * Dark (high contrast) -- `--accent-text` itself sits too close to those presets' near-black
 * backgrounds. `--command-pill-bg` is now a plain neutral step chosen ONLY to clear 1.4:1 (no
 * text-contrast constraint on it); `--command-pill-fg` is the SAME hue as `--accent-text`
 * (gate round 3 fix: Dark/Obsidian's own hue had drifted 15-25 degrees off the real accent hue,
 * see each theme's own comment in globals.css), lightened/desaturated only as far as needed to
 * clear 4.5:1 (7:1 in Dark high contrast) on THIS fill -- a visibly lighter step of the same
 * accent family, not a different colour. Nordic Frost/Cyber Amber need no lightened step at all
 * (`--muted` already clears both floors against the existing `--accent-text`), so their
 * `--command-pill-fg` is a plain alias of it. See each theme's own comment in `globals.css` and
 * the enforced pairs in `scripts/theme-contrast-pairs.mjs` for the measured numbers -- no
 * accepted gap in any preset now. No border (decision 3); `rounded-sm` matches `--radius`'s own
 * small step, the same class `ChipOverlaySegments`'s own pill uses; no PADDING, so the pill
 * never widens the inline box past the token's own glyph width (no layout shift, no caret/
 * geometry drift against the real textarea). Gate round 3 fix (UI Medium): the "/" and the
 * token's own first/last glyph used to sit flush against the fill's own edge -- `shadow-[0_0_0_
 * 2px_var(--command-pill-bg)]` adds a 2px solid ring in the SAME colour as the fill, painted by
 * `box-shadow` (which never reserves layout space, unlike `padding`) so the fill visually reads
 * 2px larger on every side with zero effect on the element's own box size or any sibling's
 * position -- the standard "fake padding via box-shadow" technique. `[box-decoration-break:
 * clone]` repeats the fill/rounding/shadow cleanly on every visual line fragment a wrapped
 * token could cross. */
const PILL_CLASS = 'rounded-sm bg-command-pill-bg text-command-pill-fg shadow-[0_0_0_2px_var(--command-pill-bg)] [box-decoration-break:clone]'

/** `MessageInput.tsx`'s own `<textarea>` adds this ONLY while `commandToken` is truthy (gate
 * round 1 HIGH remediation, item 1).
 *
 * Full composer stacking order (gate round 3 CRITICAL fix: the Send/Stop button container used
 * to have no z-index at all, so this textarea's own `z-[1]` painted ABOVE it despite coming
 * EARLIER in the DOM -- `elementFromPoint` at Send's own centre resolved to the textarea while a
 * pill showed, so Send/Stop could not be clicked):
 *   z-[1] (this textarea, ONLY while a pill shows) < z-[2] (ghost-text/chip mirror overlays,
 *   MessageInput.tsx's own call sites) < z-[3] (the Send/Stop button container,
 *   MessageInput.tsx) < z-10 (SlashMenu.tsx, always topmost regardless).
 * `CommandPillOverlay`'s own mirror sibling (rendered first in the DOM, directly beneath this
 * textarea) stays un-positioned/auto-z, i.e. below all of the above.
 *
 * `[-webkit-text-fill-color:transparent]`, NOT `text-transparent` (gate round 3 HIGH fix, IME):
 * masking via the standard `color` property also hid every OTHER colour-derived thing drawn
 * from it -- an IME composition underline (drawn in `currentColor` by default) went invisible
 * along with the glyphs it sits under. `-webkit-text-fill-color` masks ONLY the glyph fill;
 * `color` stays whatever it would ordinarily resolve to (a real, visible value), so anything
 * that reads `color` rather than the fill (composition underlines, any future `currentColor`
 * decoration) keeps rendering correctly. `forced-colors:[-webkit-text-fill-color:CanvasText]`:
 * the UA's forced-colours safety net that used to auto-revert a transparent `color` back to
 * `CanvasText` does NOT apply to this non-standard property, so that safeguard is re-asserted
 * explicitly here instead (not live-exercised, no forced-colours harness; `notExercised` on
 * #1050's own live check, same as before this fix). `caret-foreground`: the native caret is
 * drawn independently of text colour, so it stays fully visible at every offset, including
 * inside the (otherwise invisible) pilled token.
 *
 * Selection (gate round 3 HIGH fix): the previous `selection:text-foreground` set only `color`
 * within `::selection`, and CSS gives ANY property an author's `::selection` rule leaves unset
 * the ELEMENT's own ordinary (unselected) value for that property, never the UA's special
 * highlight -- so `background-color` fell back to this textarea's own `bg-transparent`, and the
 * "highlight" was completely invisible (confirmed live: Ctrl+A over a pilled draft painted
 * nothing). Fixed with a REAL fill (`selection:bg-composer-selection-bg`, a plain alias of the
 * existing, already-enforced `accent-foreground`/`accent` pair -- see globals.css) and an
 * explicit `-webkit-text-fill-color` override within `::selection` too: since the BASE rule
 * above forces that property transparent, `::selection` inheriting it unchanged would leave
 * selected glyphs invisible even with a real background now painted underneath, so it must be
 * reset to a real colour inside the selection rule specifically (`color` alone would not do
 * this, for the identical reason the base masking itself had to move off `color`).
 * `forced-colors:selection:` pair: the OS's own `Highlight`/`HighlightText` system colours,
 * the forced-colours-safe equivalent of the same override (not live-exercised, same
 * `notExercised` entry). */
export const COMMAND_PILL_TEXTAREA_CLASS =
  'relative z-[1] [-webkit-text-fill-color:transparent] forced-colors:[-webkit-text-fill-color:CanvasText] caret-foreground selection:bg-composer-selection-bg selection:[-webkit-text-fill-color:var(--composer-selection-fg)] forced-colors:selection:bg-[Highlight] forced-colors:selection:[-webkit-text-fill-color:HighlightText]'

/** Renders the composer mirror for a recognised command/skill token: the WHOLE draft, visibly --
 * plain `--foreground` text before and after the token, the token itself as the pill. `null`
 * when there is no recognised token (the caller never even mounts this, but the guard keeps the
 * component safe to call unconditionally too). A trailing `\n` in the draft gets a zero-width-
 * space appended (the standard "highlight-within-textarea" fix, gate round 1 HIGH remediation,
 * item 4): `white-space: pre-wrap` collapses a final blank line with no visible content after it,
 * which would otherwise leave this mirror's own rendered height one line SHORTER than the real
 * textarea's (a native control DOES give a trailing newline's blank line its own line box). */
export function CommandPillOverlay({
  text,
  token,
  overlayRef
}: {
  text: string
  token: RecognisedCommandToken | undefined
  overlayRef: RefObject<HTMLDivElement | null>
}): ReactNode {
  if (!token) return null
  const before = text.slice(0, token.start)
  const pillText = text.slice(token.start, token.end)
  const afterRaw = text.slice(token.end)
  const after = afterRaw.endsWith('\n') ? afterRaw + '\u200b' : afterRaw
  return (
    <div ref={overlayRef} aria-hidden="true" data-command-pill-overlay className={COMPOSER_MIRROR_CLASS}>
      {before}
      <span data-command-pill-token className={PILL_CLASS}>
        {pillText}
      </span>
      {after}
    </div>
  )
}

/** `MessageInput.tsx`'s own integration point (working rule 11, file-size cap: that file has no
 * room for the ref/memo/scroll-sync wiring this needs, only the hook call plus `<CommandPillOverlay
 * .../>` at the render call-site). The scroll sync uses `useLayoutEffect`, not `useEffect` (gate
 * round 1 HIGH remediation, item 4): a freshly mounted mirror defaults to `scrollTop: 0`, and
 * `useLayoutEffect` applies the real scroll position synchronously before the browser ever
 * paints that first frame, so a token at the top of an already-scrolled multi-line draft is never
 * visible, even momentarily, at the wrong scroll offset. */
export function useCommandPillOverlay(text: string, commands: readonly SlashCommand[], textareaRef: RefObject<HTMLTextAreaElement | null>) {
  const commandToken = useMemo(() => findRecognisedCommandToken(text, commands), [text, commands])
  const commandPillOverlayRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (commandToken && commandPillOverlayRef.current && textareaRef.current) {
      commandPillOverlayRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [commandToken, textareaRef])
  return { commandToken, commandPillOverlayRef }
}
