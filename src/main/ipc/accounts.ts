// IPC handlers for `accounts.*` (contracts/ipc.md "GitHub accounts", "OMP provider sign-in") and
// `app.openReleaseNotes` (FR-023, tasks.md T008/T009).
//
// GitHub half (T008): lists/adds/switches/signs out GitHub CLI accounts via `github/cli.ts`,
// enriching each with `profileCache.json`'s cached display fields (`github/profile.ts`,
// `store/profileCache.ts`) and refreshing that cache opportunistically in the background
// (research.md decision 5) -- `list()` itself never blocks on a live fetch; it always answers
// from whatever is already cached, `null` included (the UI falls back to login/initials).
//
// OMP half (T009): research.md decision 6 / docs/spike/FINDINGS.md item 43 confirmed omp 18.5.1
// exposes no `/login` or `/logout` command over rpc-ui at all, on either an isolated profile or
// the real signed-in default profile. This is the fallback branch: `signIn`/`signOut`/`answer`
// unconditionally refuse (`unsupported`/`not-found`) rather than driving a flow that cannot
// exist. Only `list()` does a real, read-only scratch-`OmpProcess` probe, mirroring
// `readiness.ts`'s `checkOmpSignedIn`. contracts/ipc.md's prose describes a
// `classifyDialog`/`buildDialogResponse` relaying machinery for the dialog a real `/login`/
// `/logout` could raise; that machinery has no live caller in this fallback branch and would be
// dead, unverifiable code, so it is not built here -- this comment is the promised note citing
// FINDINGS item 43 instead.

import { app, ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RpcCommand } from '../../shared/frames';
import { IPC_EVENTS, IPC_REQUESTS } from '../../shared/ipc';
import type { GitHubAccount, GitHubAddFlowProgress, IpcErrorCode, OmpProviderState, Result } from '../../shared/ipc';
import type { GhLoginExitInfo, GhLoginFlow } from '../github/cli';
import { GhError, authLoginCancel, authLoginStart, authLogout, authStatus, authSwitch } from '../github/cli';
import { fetchAvatar, fetchProfile } from '../github/profile';
import { openExternalSafe } from '../index';
import { OmpProcess } from '../omp/OmpProcess';
import { ProfileCacheStore } from '../store/profileCache';
import type { SessionManager } from '../SessionManager';

// Opened lazily on first use (not at module load, since `app.getPath('userData')` is only valid
// once Electron is ready) and reused afterward -- the same single-store-instance pattern
// `RegistryStore`/`SettingsStore` use, just owned by this file instead of threaded through
// `SessionManager`, since nothing else in the app needs the GitHub display cache.
let profileCachePromise: Promise<ProfileCacheStore> | undefined;

function getProfileCache(): Promise<ProfileCacheStore> {
  profileCachePromise ??= ProfileCacheStore.open(app.getPath('userData'));
  return profileCachePromise;
}

// Tracks every add-account flow currently in flight, keyed by the `flowId` handed back from
// `addStart`, so a later `addCancel(flowId)` can find the right `GhLoginFlow` to cancel.
const activeAddFlows = new Map<string, GhLoginFlow>();
let addFlowSeq = 0;

export function registerAccounts(manager: SessionManager, getWindow: () => BrowserWindow | undefined): void {
  void manager; // no SessionManager state is needed here; kept for signature parity with the other area files

  ipcMain.handle(IPC_REQUESTS.ACCOUNTS_GITHUB_LIST, async (): Promise<Result<GitHubAccount[]>> => {
    try {
      return { ok: true, value: await listGithubAccounts() };
    } catch (err) {
      return toGithubError(err);
    }
  });

  ipcMain.handle(IPC_REQUESTS.ACCOUNTS_GITHUB_ADD_START, async (): Promise<Result<{ flowId: string }>> => {
    try {
      // contracts/ipc.md: always `github.com` -- `switch`/`signOut` are the only operations that
      // ever take an explicit host, since adding a *new* account is always against github.com.
      const flow = await authLoginStart('github.com');
      const flowId = `gh-add-${Date.now()}-${++addFlowSeq}`;
      activeAddFlows.set(flowId, flow);
      let lastCode = '';
      flow.on('code', (code: string) => {
        lastCode = code;
        broadcastAddProgress(getWindow, { flowId, code: lastCode, status: 'waiting' });
      });
      flow.on('exit', ({ code, requested }: GhLoginExitInfo) => {
        activeAddFlows.delete(flowId);
        const status: GitHubAddFlowProgress['status'] = requested ? 'cancelled' : code === 0 ? 'completed' : 'failed';
        broadcastAddProgress(getWindow, { flowId, code: lastCode, status });
        if (status === 'completed') {
          void listGithubAccounts().then(
            (accounts) => broadcastGithubChanged(getWindow, accounts),
            (err) => console.error('accounts: failed to refresh GitHub accounts after a completed add flow', err)
          );
        }
      });
      return { ok: true, value: { flowId } };
    } catch (err) {
      if (err instanceof GhError) {
        return { ok: false, error: { code: err.code, message: err.message } };
      }
      // `authLoginStart` can also throw a plain `Error` from `resolveExecutable('gh')` when the
      // CLI is not on PATH at all, before any `GhError` would ever be constructed.
      return { ok: false, error: { code: 'gh-not-found', message: err instanceof Error ? err.message : String(err) } };
    }
  });

  ipcMain.handle(IPC_REQUESTS.ACCOUNTS_GITHUB_ADD_CANCEL, async (_event, flowId: unknown): Promise<Result<void>> => {
    if (typeof flowId !== 'string') {
      return { ok: false, error: { code: 'invalid-argument', message: `accounts.github.addCancel expects a string flowId, got ${JSON.stringify(flowId)}` } };
    }
    const flow = activeAddFlows.get(flowId);
    if (flow) {
      await authLoginCancel(flow);
    }
    return { ok: true, value: undefined };
  });

  ipcMain.handle(IPC_REQUESTS.ACCOUNTS_GITHUB_SWITCH, async (_event, host: unknown, login: unknown): Promise<Result<GitHubAccount[]>> => {
    return runGithubAccountMutation(host, login, getWindow, authSwitch);
  });

  ipcMain.handle(IPC_REQUESTS.ACCOUNTS_GITHUB_SIGN_OUT, async (_event, host: unknown, login: unknown): Promise<Result<GitHubAccount[]>> => {
    return runGithubAccountMutation(host, login, getWindow, authLogout);
  });

  ipcMain.handle(IPC_REQUESTS.ACCOUNTS_OMP_LIST, async (): Promise<Result<OmpProviderState[]>> => {
    const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'refract-accounts-omp-'));
    // Same scratch, non-Session construction readiness.ts's `checkOmpSignedIn` uses: this probe
    // never calls `open_session` or anything else requiring persistence, only the one read-only
    // `get_login_providers` command (research.md decision 6, FINDINGS item 15).
    const proc = new OmpProcess({ cwd: scratchDir, approvalMode: 'ask', sessionId: 'accounts-omp-probe', noSession: true });
    try {
      await proc.start();
      const res = await proc.request({ type: 'get_login_providers', id: '' } as unknown as RpcCommand);
      if (!res.success) {
        return { ok: false, error: { code: 'omp-probe-failed', message: 'omp did not answer get_login_providers successfully' } };
      }
      const providers = (res.data as { providers?: Array<{ id: string; authenticated?: boolean }> } | undefined)?.providers ?? [];
      const value: OmpProviderState[] = providers.map((provider) => ({ id: provider.id, authenticated: provider.authenticated === true }));
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: { code: 'omp-probe-failed', message: err instanceof Error ? err.message : String(err) } };
    } finally {
      await proc.stop().catch(() => undefined);
      await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // research.md decision 6 fallback: no `/login`/`/logout` can ever be driven over rpc-ui, so
  // both unconditionally refuse. The signature matches contracts/ipc.md exactly so a future omp
  // version that does support this can be wired up later without an API change.
  ipcMain.handle(IPC_REQUESTS.ACCOUNTS_OMP_SIGN_IN, async (): Promise<Result<{ requestId: string | null }>> => {
    return {
      ok: false,
      error: { code: 'unsupported', message: 'omp has no /login command available over rpc-ui (FINDINGS item 43); run omp in a terminal and use /login there.' }
    };
  });

  ipcMain.handle(IPC_REQUESTS.ACCOUNTS_OMP_SIGN_OUT, async (): Promise<Result<{ requestId: string | null }>> => {
    return {
      ok: false,
      error: { code: 'unsupported', message: 'omp has no /logout command available over rpc-ui (FINDINGS item 43); run omp in a terminal and use /logout there.' }
    };
  });

  // No `signIn`/`signOut` flow can ever start in this fallback branch, so there is never a
  // pending dialog for this to resolve; kept with contracts/ipc.md's exact signature for the
  // same forward-compatibility reason as the two handlers above.
  ipcMain.handle(IPC_REQUESTS.ACCOUNTS_OMP_ANSWER, async (): Promise<Result<void>> => {
    return { ok: false, error: { code: 'not-found', message: 'No pending accounts.omp dialog to answer.' } };
  });

  ipcMain.handle(IPC_REQUESTS.APP_OPEN_RELEASE_NOTES, async (): Promise<Result<void>> => {
    openExternalSafe(`https://github.com/stuarthopwood/refract/releases/tag/v${app.getVersion()}`);
    return { ok: true, value: undefined };
  });
}

/** Flattens `authStatus()` with `profileCache.json`'s cached display fields, then kicks off a
 * background refresh of that cache for every account (research.md decision 5) -- the returned
 * list always reflects whatever was already cached, `null` included; the refresh is for next
 * time, never this call. */
async function listGithubAccounts(): Promise<GitHubAccount[]> {
  const hosts = await authStatus();
  const cache = await getProfileCache();
  const accounts: GitHubAccount[] = hosts.map((entry) => {
    const cached = cache.get(entry.host, entry.login);
    return {
      host: entry.host,
      login: entry.login,
      active: entry.active,
      state: entry.state,
      displayName: cached?.displayName ?? null,
      avatarDataUrl: cached?.avatarDataUrl ?? null
    };
  });
  for (const entry of hosts) {
    void refreshProfileCache(cache, entry.host, entry.login);
  }
  return accounts;
}

/** Best-effort: a failed profile fetch leaves the cache entirely untouched (data-model.md "a
 * failed or skipped fetch... leaves the previous entry untouched"); a failed avatar fetch after a
 * successful profile fetch keeps the previously cached avatar rather than clearing it. Never
 * throws -- callers fire this and forget it. */
async function refreshProfileCache(cache: ProfileCacheStore, host: string, login: string): Promise<void> {
  try {
    const profile = await fetchProfile(host, login);
    const previous = cache.get(host, login);
    let avatarDataUrl = previous?.avatarDataUrl ?? null;
    if (profile.avatarUrl) {
      try {
        avatarDataUrl = await fetchAvatar(profile.avatarUrl);
      } catch (err) {
        console.debug(`accounts: avatar refresh failed for ${login}@${host}, keeping the previously cached avatar`, err instanceof Error ? err.message : err);
      }
    }
    await cache.set(host, login, { displayName: profile.displayName, avatarDataUrl, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.debug(`accounts: opportunistic profile refresh failed for ${login}@${host}`, err instanceof Error ? err.message : err);
  }
}

/** Shared body of `switch`/`signOut`: validate the pair against the current `authStatus()` list
 * (contracts/ipc.md "`account-not-found`") before ever invoking the CLI, run the mutation, then
 * return and broadcast the refreshed list. */
async function runGithubAccountMutation(
  host: unknown,
  login: unknown,
  getWindow: () => BrowserWindow | undefined,
  mutate: (host: string, login: string) => Promise<void>
): Promise<Result<GitHubAccount[]>> {
  if (typeof host !== 'string' || typeof login !== 'string') {
    return { ok: false, error: { code: 'invalid-argument', message: 'accounts.github expects string host/login arguments' } };
  }
  try {
    const hosts = await authStatus();
    if (!hosts.some((entry) => entry.host === host && entry.login === login)) {
      return { ok: false, error: { code: 'account-not-found', message: `No GitHub CLI account ${login}@${host}` } };
    }
    await mutate(host, login);
    const refreshed = await listGithubAccounts();
    broadcastGithubChanged(getWindow, refreshed);
    return { ok: true, value: refreshed };
  } catch (err) {
    return toGithubError(err);
  }
}

function toGithubError(err: unknown): { ok: false; error: { code: IpcErrorCode; message: string } } {
  if (err instanceof GhError) {
    return { ok: false, error: { code: err.code, message: err.message } };
  }
  return { ok: false, error: { code: 'gh-failed', message: err instanceof Error ? err.message : String(err) } };
}

/** Never throws: a destroyed or not-yet-created window simply drops the event (same pattern as
 * `ipc/broadcast.ts`'s `broadcastSettingsChanged`). */
function broadcastAddProgress(getWindow: () => BrowserWindow | undefined, payload: GitHubAddFlowProgress): void {
  const window = getWindow();
  if (window && !window.isDestroyed()) {
    try {
      window.webContents.send(IPC_EVENTS.ACCOUNTS_GITHUB_ADD_PROGRESS, payload);
    } catch (err) {
      console.error('accounts: failed to broadcast accounts:github-add-progress', err);
    }
  }
}

function broadcastGithubChanged(getWindow: () => BrowserWindow | undefined, accounts: GitHubAccount[]): void {
  const window = getWindow();
  if (window && !window.isDestroyed()) {
    try {
      window.webContents.send(IPC_EVENTS.ACCOUNTS_GITHUB_CHANGED, accounts);
    } catch (err) {
      console.error('accounts: failed to broadcast accounts:github-changed', err);
    }
  }
}
