/** `omp-guard:reset` payload (#1184): one OMP settings guard run that reset or failed a guarded
 * key. Kept out of `shared/ipc.ts` (over the file-size cap) and re-exported from there. */
export interface OmpGuardNotice {
  id: number;
  resets: { key: string; old: string; new: string }[];
  failures: { key: string; old: string; new: string; error: string }[];
  overrides: { key: string; file: string }[];
}
