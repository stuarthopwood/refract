// Update availability check (spec 006 FR-012 to FR-019, FR-026, research.md decision 3): a
// hand-rolled checker that only ever shells out to the developer's own already-signed-in `gh`
// CLI (resolved via the existing `resolveExecutable('gh')`, through `src/main/github/gh.ts`'s
// `ghJson`/`GhError`/`githubCliStatus`) -- never a stored token (spec 003 FR-027's same stance).

import { app } from 'electron';
import { GhError, ghJson, githubCliStatus } from '../github/gh';
import type { UpdateState } from '../../shared/ipc';
import type { UpdateStateStore } from '../store/updateState';

// research.md decision 8: the private repository every release is published to.
const REPO = 'stuarthopwood/refract';

interface GhReleaseListEntry {
  tagName: string;
  isDraft: boolean;
  isPrerelease: boolean;
}

interface GhReleaseAssets {
  assets: Array<{ name: string }>;
}

/** research.md decision 9: a small hand-written three-part numeric compare, not the `semver`
 * package -- FR-019/FR-026 already filter out every pre-release/draft/malformed tag before a
 * version ever reaches this comparison, so every version compared here is a plain `X.Y.Z` string
 * with no suffix to parse. Returns positive when `a` is newer than `b`, negative when older, `0`
 * when equal. */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const partsB = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Quality-gate remediation (LOW "tag names not validated" / HIGH "pre-release guard fails open
// at both ends"): every release's own tag is checked against this before it is ever compared or
// passed to a second `gh` call -- `isDraft`/`isPrerelease` alone do not catch every non-plain
// tag shape (a mistyped or non-standard tag, e.g. `v1.2.0-rc1` with no dot before `rc`, or
// `1.2.0` with no leading `v`), and `compareVersions`'s `Number.parseInt(...) || 0` silently
// reads a suffix like `-rc.1` as `0`, which would otherwise let a pre-release outrank a real
// release with the same numeric prefix. Lowercase `v` only, matching the tags
// `.github/workflows/release.yml` actually produces.
const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/;

/** contracts/ipc.md "Updates": phases a check must never clobber, whichever caller runs it
 * (data-model.md's own phase-transition table only allows `check()` from idle/available/failed). */
const BUSY_PHASES = new Set<UpdateState['phase']>(['downloading', 'downloaded', 'installing']);

/** `updates.check()` (contracts/ipc.md): never throws, never resolves to an `IpcError`.
 *
 * Quality-gate remediation (HIGH "checkForUpdates overwrites whatever phase is current"):
 * `options.automatic` distinguishes `ipc/updates.ts`'s startup call (`startAutomaticUpdateCheck`)
 * from the user-initiated `updates.check` IPC request:
 * - Both are a no-op (return the current state unchanged) while `downloading`, `downloaded`, or
 *   `installing` -- a check must never clobber a download in flight or a verified installer
 *   already waiting for the next quit.
 * - Only the automatic one is ALSO a no-op on `failed` -- `resolveInstallingState`'s own
 *   `lastError` (FR-018) must survive the startup check that runs right after it; the
 *   user-initiated call (the status bar's own "Try again") still re-checks from `failed`.
 *
 * Finds the newest non-draft, non-prerelease release among every release whose tag matches
 * `RELEASE_TAG_RE` and whose assets include both an installer and a checksum file, taking the
 * maximum qualifying version over the whole list rather than stopping at the first entry newer
 * than `app.getVersion()` -- quality-gate remediation (LOW): `gh release list`'s order is by
 * creation date, not version, so a later-created backport release could otherwise stop the scan
 * before a higher, earlier-created version is ever considered. */
export async function checkForUpdates(store: UpdateStateStore, options: { automatic: boolean }): Promise<UpdateState> {
  const state = store.get();
  if (BUSY_PHASES.has(state.phase)) return state;
  if (options.automatic && state.phase === 'failed') return state;

  const cwd = app.getPath('userData');
  const now = new Date().toISOString();

  const access = await githubCliStatus(cwd);
  if (access !== 'ok') {
    return store.update({ phase: 'idle', unavailableReason: access, lastCheckedAt: now });
  }

  try {
    const releases = await ghJson<GhReleaseListEntry[]>(cwd, [
      'release',
      'list',
      '--repo',
      REPO,
      '--json',
      'tagName,isDraft,isPrerelease',
      '--limit',
      '20'
    ]);

    let best: { version: string; tagName: string } | undefined;
    for (const release of releases) {
      // FR-019, FR-026: a pre-release or draft release is never offered as an update.
      if (release.isDraft || release.isPrerelease) continue;
      if (!RELEASE_TAG_RE.test(release.tagName)) continue;
      const version = release.tagName.slice(1);
      // Only fetch this release's assets if it could actually improve on the best complete
      // candidate found so far -- same `gh` call volume as the old first-match behaviour in the
      // common case (the newest release usually does have complete assets), strictly more in the
      // rare backport case the fix above targets.
      if (best && compareVersions(version, best.version) <= 0) continue;
      const detail = await ghJson<GhReleaseAssets>(cwd, ['release', 'view', release.tagName, '--repo', REPO, '--json', 'assets']);
      const hasInstaller = detail.assets.some((a) => a.name.toLowerCase().endsWith('.exe'));
      const hasChecksum = detail.assets.some((a) => a.name.toLowerCase().endsWith('.sha256'));
      // FR-026: a release missing either asset is ignored entirely, never offered.
      if (!hasInstaller || !hasChecksum) continue;
      best = { version, tagName: release.tagName };
    }

    if (best && compareVersions(best.version, app.getVersion()) > 0) {
      return store.update({
        phase: 'available',
        availableVersion: best.version,
        notesUrl: `https://github.com/${REPO}/releases/tag/${best.tagName}`,
        lastCheckedAt: now,
        unavailableReason: undefined,
        lastError: undefined
      });
    }
    return store.update({ phase: 'idle', lastCheckedAt: now, unavailableReason: undefined });
  } catch (err) {
    // Quality-gate remediation (LOW "every release list/view failure is reported as offline"):
    // `githubCliStatus` already confirmed `gh` is installed and reachable above, so a failure here
    // (rate limiting, a 404/no-access response, invalid JSON) is a `gh`-reported failure, not
    // necessarily the network. `ghJson` only ever throws `GhError` -- `'not-installed'` only when
    // `gh` itself disappeared mid-session (`gh-unavailable`), `'offline'` as the closest remaining
    // fit in `UpdateState.unavailableReason`'s fixed three-value enum for every other
    // `GhErrorCode` this surface can throw (rate-limited, github-failed, a bad-JSON response, ...).
    const reason = err instanceof GhError && err.code === 'gh-unavailable' ? 'not-installed' : 'offline';
    return store.update({ phase: 'idle', unavailableReason: reason, lastCheckedAt: now });
  }
}
