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
// else in plain `--foreground` text; `MessageInput.tsx`'s own `<textarea>` masks its own glyph
// fill ONLY while a token is present (`COMMAND_PILL_TEXTAREA_CLASS` below has the exact classes
// and the full reasoning for using a text-fill override there instead of the standard `color`
// property): its own glyphs become invisible
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
// Gate round 5 fix (#1050, test review): the composer's text-selection highlight is now a
// TRANSLUCENT accent-text tint (`--composer-selection-bg`, `color-mix(in oklab, var(--accent-
// text) 34%, transparent)`), applied UNCONDITIONALLY by `COMPOSER_SELECTION_CLASS` below --
// `MessageInput.tsx`'s own `<textarea>` carries it regardless of whether a pill shows, so a
// draft's selection looks identical whether or not the leading token happens to be a recognised
// command. The previous opaque `var(--accent)` fill (round 3) measured EQUAL to
// `--command-pill-bg` in Nordic Frost (aliases `--muted`/`--accent` to the same resolved
// colour there; Cyber Amber did too, until #1039, 2026-10-20, retuned it off that alias onto
// its own literal), so selecting the pilled token itself painted an invisible highlight --
// found in this round's test review. A translucent tint lets the pill's own fill show through
// underneath it, so the highlight is always visibly distinct from whatever it sits on, by
// construction, in every theme (`scripts/composer-selection-contrast.mjs`'s own
// `composerSelectionContrastRows` has the measured numbers: >=1.5:1 against the pill, enforced;
// against the near-black `--background`/`--composer-background` themselves, no alpha in this
// window reaches 3:1 without exceeding the text-legibility floor below, so that comparison is
// informational only, same shape as this codebase's other accepted gaps). Text still restores
// via `color: var(--composer-selection-fg)` (a dedicated declaration, not an inherited default)
// with `-webkit-text-fill-color: currentColor` re-asserting the fill to track it -- WebView2
// does not reliably apply a `::selection`-scoped override of that property in every case
// (confirmed live, same engine gap `forced-colors:` already works around), so this is belt-and-
// braces: when the override DOES apply, selected glyphs paint in the dedicated colour; when it
// doesn't, the translucent highlight underneath still lets the real glyph colour (painted by
// this mirror, or -- with no pill -- by the textarea itself) show through regardless.
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
  'pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2 py-2 pr-20 font-code text-base text-foreground [scrollbar-gutter:stable] md:text-sm'

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
 * accent family, not a different colour. Nordic Frost needs no lightened step at all (`--muted`
 * already clears both floors against the existing `--accent-text`), so its `--command-pill-fg`
 * is a plain alias of it. Cyber Amber did too originally, until #1039 (2026-10-20) retuned its
 * surfaces to Default Dark's own pure-neutral values: the new, lighter `--muted` no longer
 * clears the 1.4:1 floor against the new, darker-relative `--background` (1.31:1), so Cyber
 * Amber's own `--command-pill-bg` is now a literal too (Dark's own `oklch(0.31 0 0)`, since its
 * `--background` is now byte-identical to Dark's) -- `--command-pill-fg` still needs no
 * lightened step (the vivid orange accent clears 4.5:1 on that fill directly, 5.83:1). See each
 * theme's own comment in `globals.css` and the enforced pairs in `scripts/theme-contrast-
 * pairs.mjs` for the measured numbers -- no accepted gap in any preset now.
 * No border (decision 3); `rounded-sm` matches `--radius`'s own
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
const PILL_CLASS = 'rounded-sm bg-command-pill-bg text-command-pill-fg shadow-[-2px_0_0_2px_var(--command-pill-bg),2px_0_0_2px_var(--command-pill-bg)] [box-decoration-break:clone]'

/** `MessageInput.tsx`'s own `<textarea>` adds this ONLY while `commandToken` is truthy (gate
 * round 1 HIGH remediation, item 1) -- the glyph-masking half of the highlight-within-textarea
 * technique. Gate round 5: the SELECTION styling that used to live here moved out to
 * `COMPOSER_SELECTION_CLASS` below, which the textarea now carries UNCONDITIONALLY (full
 * reasoning in this file's own header comment) -- this constant is masking-only now.
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
 * inside the (otherwise invisible) pilled token. */
export const COMMAND_PILL_TEXTAREA_CLASS =
  'relative z-[1] [-webkit-text-fill-color:transparent] forced-colors:[-webkit-text-fill-color:CanvasText] caret-foreground'

/** `MessageInput.tsx`'s own `<textarea>` carries this UNCONDITIONALLY (gate round 5 fix, test
 * review: see this file's own header comment for the full reasoning) -- the composer's
 * selection highlight looks identical whether or not a pill shows, so there is no visible
 * discontinuity the instant a recognised command's own leading token appears or disappears.
 *
 * `selection:bg-composer-selection-bg`: a TRANSLUCENT accent-text tint (34% alpha,
 * `globals.css`), not an opaque fill -- round 3's opaque `var(--accent)` alias happened to
 * measure EQUAL to `--command-pill-bg` in Nordic Frost (Cyber Amber too, until #1039,
 * 2026-10-20, retuned it off that same alias), so selecting the pilled
 * token itself painted an invisible highlight (this round's test-review finding). A translucent
 * tint lets whatever is underneath (the pill's own fill, or the plain composer surface) show
 * through, so it is visibly distinct from its own backdrop by construction, in every theme.
 *
 * A selection-scoped `color` override (a dedicated token) AND a selection-scoped text-fill
 * override re-asserting the fill to track it. Belt-and-braces for the same
 * WebView2 gap the base masking rule above already works around: `-webkit-text-fill-color`
 * cannot be relied on to track `color` through a `::selection` override in every engine, so both
 * are set explicitly rather than assuming one implies the other.
 *
 * `forced-colors:` pair: the OS's own `Highlight`/`HighlightText` system colours, the forced-
 * colours-safe equivalent of the same override (not live-exercised, no forced-colours harness;
 * `notExercised` on #1050's own live check). */
export const COMPOSER_SELECTION_CLASS =
  'selection:bg-composer-selection-bg selection:text-composer-selection-fg selection:[-webkit-text-fill-color:currentColor] forced-colors:selection:bg-[Highlight] forced-colors:selection:text-[HighlightText] forced-colors:selection:[-webkit-text-fill-color:HighlightText]'

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
