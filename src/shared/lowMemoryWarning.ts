/** `memory:warning` payload (issue #560, spec 001 FR-037; contracts/ipc.md). Originally defined
 * inline in `shared/ipc.ts`; moved from there into `shared/model.ts` by this story's own T268
 * (issue #554's first commit), citing issue #806's 600-line file-size-cap rule as the reason
 * `ipc.ts` had no slack left -- NOT a move issue #806 itself performed, a correction to this
 * comment's own earlier wrong attribution (gate round 2 PASS, Low finding). Moved again, by
 * this story's own gate round 2 fixes (M6), out of `model.ts` into its own file, since
 * `model.ts` ALSO had no slack left for #554's additions by then -- re-exported from
 * `shared/ipc.ts` so every existing import from there keeps working unchanged. */
export interface LowMemoryWarning {
  low: boolean;
  freeBytes: number;
  liveAgents: number;
}
