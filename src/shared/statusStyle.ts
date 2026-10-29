/** Issue #482 (Settings, Appearance "Status style"): how the shared status icon draws a Session
 * state. `'icons'` (the default) is a distinct glyph per state; `'dots'` is a distinct dot shape
 * per state. Its own file because `model.ts` is over the 600-line cap (issue #806). */
export type StatusStyle = 'icons' | 'dots';
