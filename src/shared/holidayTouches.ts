/** Issue #1048 (Settings, Appearance "Holiday touches", next to the watermark switch): the
 * three-way control gating every seasonal artwork placement (chat watermark, start messages,
 * sidebar logo, empty states, the agent-working spinner glyph) and the ambient loops layered on
 * top of them. `'full'` (the default) shows both artwork and ambient loops; `'artwork'` keeps
 * the static artwork but never the looping motion; `'off'` shows nothing holiday-related at all.
 * This is the WCAG 2.2.2 pause/stop/hide mechanism `docs/design/foundations-motion.md`'s own
 * "Holiday touches" exception requires for the ambient loops -- the auto-pause rules (hidden or
 * unfocused window, 60s idle, OS reduced motion) are the other half, applied on top of this
 * setting, never instead of it. Split into its own file (not inlined in `model.ts`), the same
 * precedent `chatWidth.ts`/`themes.ts` already set, since `model.ts` is already over this
 * build's 600-line cap (issue #806) with no slack for a new type. */
export type HolidayTouches = 'full' | 'artwork' | 'off';
