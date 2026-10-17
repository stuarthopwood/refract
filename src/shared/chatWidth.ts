/** Issue #554 (amends FR-049, new FR-073): Settings, Appearance "Chat width" choice. `'full'`
 * (the default) leaves the transcript column unconstrained, filling the pane; `'reading-column'`
 * caps it at 64rem, centred, with wider side padding -- transcript only, never the message box
 * or the status line (ui-architect-v3 roundtable, Decided, Skippy, delegated by Stuart
 * 2026-10-18). Split into its own file rather than inlined in `model.ts` (not re-exported from
 * there either) -- the same precedent `ThemeId` already sets in `themes.ts`, since `model.ts` is
 * already over this build's 600-line cap (issue #806) with no slack for a new type.
 */
export type ChatWidth = 'full' | 'reading-column';
