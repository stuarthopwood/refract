// IPC handlers for `modelRoles.*` (issue #455). Thin wrapper over `src/main/omp/config.ts`'s
// `omp config`/`omp models` CLI calls: no `SessionManager`/`Settings` dependency at all, since
// model roles live in OMP's own global config, not in Refract's `settings.json`.

import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { Result } from '../../shared/ipc';
import { isCatalogKind, isModelRoleId } from '../../shared/model';
import type { ModelCatalogEntry } from '../../shared/model';
import { OmpConfigError, getModelRoles, listCatalogModels, setModelRole } from '../omp/config';

/** Maps an `OmpConfigError` (or any other thrown value) to an `IpcErrorCode`: `'timeout'` for a
 * genuine CLI timeout, `'invalid-argument'` for a caller-supplied bad value (`config.ts`'s own
 * `'invalid-value'` code -- a blank/too-long/control-character selector, or an unknown role or
 * catalog kind reaching this far), `'omp-probe-failed'` for everything else (missing binary,
 * nonzero exit, unparsable output) -- reusing the existing vocabulary `ipc/accounts.ts` already
 * established for an `omp` CLI/RPC call that failed, rather than adding new `IpcErrorCode`
 * members for the same shape of failure. */
export function toIpcError(err: unknown): { code: 'omp-probe-failed' | 'timeout' | 'invalid-argument'; message: string } {
  if (err instanceof OmpConfigError) {
    if (err.code === 'timeout') return { code: 'timeout', message: err.message };
    if (err.code === 'invalid-value') return { code: 'invalid-argument', message: err.message };
    return { code: 'omp-probe-failed', message: err.message };
  }
  return { code: 'omp-probe-failed', message: err instanceof Error ? err.message : String(err) };
}

export function registerModelRoles(): void {
  ipcMain.handle(IPC_REQUESTS.MODEL_ROLES_LIST, async (): Promise<Result<Record<string, string>>> => {
    try {
      return { ok: true, value: await getModelRoles() };
    } catch (err) {
      return { ok: false, error: toIpcError(err) };
    }
  });

  ipcMain.handle(
    IPC_REQUESTS.MODEL_ROLES_SET,
    async (_event, role: unknown, value: unknown): Promise<Result<{ roles: Record<string, string>; overriddenBy?: string }>> => {
      if (!isModelRoleId(role)) {
        return { ok: false, error: { code: 'invalid-argument', message: `${IPC_REQUESTS.MODEL_ROLES_SET} expects a known model role` } };
      }
      if (value !== null && typeof value !== 'string') {
        return { ok: false, error: { code: 'invalid-argument', message: `${IPC_REQUESTS.MODEL_ROLES_SET} expects a string value or null` } };
      }
      try {
        // `role` is already narrowed to `ModelRoleId` by the `isModelRoleId` guard above -- no cast needed.
        const written = await setModelRole(role, value);
        return { ok: true, value: written };
      } catch (err) {
        return { ok: false, error: toIpcError(err) };
      }
    }
  );

  ipcMain.handle(IPC_REQUESTS.MODEL_ROLES_LIST_CATALOG, async (_event, kind: unknown): Promise<Result<ModelCatalogEntry[]>> => {
    if (!isCatalogKind(kind)) {
      return { ok: false, error: { code: 'invalid-argument', message: `${IPC_REQUESTS.MODEL_ROLES_LIST_CATALOG} expects a known catalog kind` } };
    }
    try {
      // `kind` is already narrowed to `CatalogKind` by the `isCatalogKind` guard above -- no cast needed.
      return { ok: true, value: await listCatalogModels(kind) };
    } catch (err) {
      return { ok: false, error: toIpcError(err) };
    }
  });
}
