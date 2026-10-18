/** `memory:warning` payload (issue #560, spec 001 FR-037; contracts/ipc.md). Its own file (not
 * inline in `shared/model.ts` or `shared/ipc.ts`, issue #554 gate M6) to keep both files within
 * this build's 600-line cap (issue #806 moved it into `model.ts`; neither file had slack left
 * for #554's own additions) -- re-exported from `shared/ipc.ts` so every existing import from
 * there keeps working unchanged. */
export interface LowMemoryWarning {
  low: boolean;
  freeBytes: number;
  liveAgents: number;
}
