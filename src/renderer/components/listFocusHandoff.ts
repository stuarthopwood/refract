/** True when a whole-view reload is about to make the rows inert while focus sits inside them. */
export function shouldHandOffFocus(reloadLocksRows: boolean, activeInsideRows: boolean): boolean {
  return reloadLocksRows && activeInsideRows
}
