// IPC handlers for `modelRoles.*` (issue #455). Thin wrapper over `src/main/omp/config.ts`'s
// `omp config`/`omp models` CLI calls: no `SessionManager`/`Settings` dependency at all, since
// model roles live in OMP's own global config, not in Refract's `settings.json`.

import { ipcMain } from 'electron';
import { IPC_REQUESTS } from '../../shared/ipc';
import type { Result } from '../../shared/ipc';
import { isModelRoleId } from '../../shared/model';
import type { CatalogKind, ModelCatalogEntry, ModelRoleId } from '../../shared/model';
import { OmpConfigError, getModelRoles, listCatalogModels, setModelRole } from '../omp/config';

const CATALOG_KINDS: Record<string, true> = { chat: true, tiny: true, image: true, tts: true, stt: true, search: true, judge: true };

/** Maps an `OmpConfigError` (or any other thrown value) to one of the two `IpcErrorCode`s this
 * surface uses: `'timeout'` for a genuine CLI timeout, `'omp-probe-failed'` for everything else
 * (missing binary, nonzero exit, unparsable output) -- reusing the existing vocabulary
 * `ipc/accounts.ts` already established for an `omp` CLI/RPC call that failed, rather than adding
 * new `IpcErrorCode` members for the same shape of failure. */
function toIpcError(err: unknown): { code: 'omp-probe-failed' | 'timeout'; message: string } {
  if (err instanceof OmpConfigError) {
    return { code: err.code === 'timeout' ? 'timeout' : 'omp-probe-failed', message: err.message };
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
        const written = await setModelRole(role as ModelRoleId, value);
        return { ok: true, value: written };
      } catch (err) {
        return { ok: false, error: toIpcError(err) };
      }
    }
  );

  ipcMain.handle(IPC_REQUESTS.MODEL_ROLES_LIST_CATALOG, async (_event, kind: unknown): Promise<Result<ModelCatalogEntry[]>> => {
    if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(CATALOG_KINDS, kind)) {
      return { ok: false, error: { code: 'invalid-argument', message: `${IPC_REQUESTS.MODEL_ROLES_LIST_CATALOG} expects a known catalog kind` } };
    }
    try {
      return { ok: true, value: await listCatalogModels(kind as CatalogKind) };
    } catch (err) {
      return { ok: false, error: toIpcError(err) };
    }
  });
}
