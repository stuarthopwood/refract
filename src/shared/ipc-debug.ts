// Issue #1048's `debug.getOverrides` IPC contract, split into its own file to keep `ipc.ts` at
// its existing file-size baseline (issue #806, `scripts/check-file-size.mjs`) -- pure extraction,
// no existing export moves, same precedent `ipc-model.ts`/`ipc-attachments.ts` already set.

import type { Result } from './ipc';

/** `RefractApi.debug.getOverrides`'s success payload: debug-build-only knobs, always answerable
 * (never `unsupported`) regardless of build -- a release build's own answer is simply always
 * inert (`{ date: null, idleTimeoutMs: null, flightIntervalMs: null }`), the same posture
 * `lib.rs::data_dir`'s `REFRACT_DATA_DIR` already sets for the equivalent Rust-only override. */
export interface DebugOverrides {
  date: string | null;
  idleTimeoutMs: number | null;
  flightIntervalMs: number | null;
}

/** Issue #1048 (R-lane live-check harness): `RefractApi.debug`, read once at startup
 * (`init-stores.ts`), never polled. */
export interface DebugApi {
  getOverrides(): Promise<Result<DebugOverrides>>;
}
