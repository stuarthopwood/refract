// Update availability check (spec 006 FR-012 to FR-019, FR-026, research.md decision 3): a
// hand-rolled checker that only ever shells out to the developer's own already-signed-in `gh`
// CLI (resolved via the existing `resolveExecutable('gh')`, through `src/main/github/gh.ts`'s
// `ghRaw`/`ghJson`/`GhError`) -- never a stored token (spec 003 FR-027's same stance).

import { app } from 'electron';
import { GhError, ghJson, ghRaw } from '../github/gh';
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
 * package -- FR-019 already filters out every pre-release/draft before a version ever reaches
 * this comparison, so every version compared here is a plain `X.Y.Z` tag with no suffix to parse.
 * Returns positive when `a` is newer than `b`, negative when older, `0` when equal. */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const partsB = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// UNVERIFIED: gate T005 pending (research.md decision 3) -- the exact text `gh auth status`
// prints for "not signed in" versus "offline" has not yet been confirmed live against this
// private repository; this heuristic is the best available reading of gh's documented error
// behaviour and keeps both cases out of a generic error toast either way (FR-017), re-classifying
// only which plain-words reason is shown to the developer.
const OFFLINE_RE = /could not resolve host|enotfound|getaddrinfo|network is unreachable|timed? ?out|econnrefused|econnreset/i;
const NOT_SIGNED_IN_RE = /not logged (?:in|into)|no oauth token|you are not logged in|gh auth login/i;

async function checkGithubAccess(cwd: string): Promise<'ok' | 'not-installed' | 'not-signed-in' | 'offline'> {
  let auth: { code: number; stdout: string; stderr: string };
  try {
    auth = await ghRaw(cwd, ['auth', 'status']);
  } catch (err) {
    if (err instanceof GhError && err.code === 'gh-unavailable') return 'not-installed';
    return 'offline';
  }
  if (auth.code === 0) return 'ok';
  const text = `${auth.stdout}\n${auth.stderr}`;
  if (OFFLINE_RE.test(text)) return 'offline';
  if (NOT_SIGNED_IN_RE.test(text)) return 'not-signed-in';
  return 'not-signed-in';
}

/** `updates.check()` (contracts/ipc.md): never throws, never resolves to an `IpcError` -- an
 * unreachable GitHub CLI resolves `phase: 'idle'` with `unavailableReason` set (FR-017). Finds
 * the newest non-draft, non-prerelease release whose assets include both an installer and a
 * checksum file and whose version is newer than `app.getVersion()` (FR-019, FR-026). */
export async function checkForUpdates(store: UpdateStateStore): Promise<UpdateState> {
  const cwd = app.getPath('userData');
  const now = new Date().toISOString();

  const access = await checkGithubAccess(cwd);
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
    for (const release of releases) {
      // FR-019, FR-026: a pre-release or draft release is never offered as an update.
      if (release.isDraft || release.isPrerelease) continue;
      const detail = await ghJson<GhReleaseAssets>(cwd, ['release', 'view', release.tagName, '--repo', REPO, '--json', 'assets']);
      const installerAsset = detail.assets.find((a) => a.name.toLowerCase().endsWith('.exe'));
      const checksumAsset = detail.assets.find((a) => a.name.toLowerCase().endsWith('.sha256'));
      // FR-026: a release missing either asset is ignored entirely, never offered.
      if (!installerAsset || !checksumAsset) continue;
      const version = release.tagName.replace(/^v/i, '');
      if (compareVersions(version, app.getVersion()) > 0) {
        return store.update({
          phase: 'available',
          availableVersion: version,
          notesUrl: `https://github.com/${REPO}/releases/tag/${release.tagName}`,
          lastCheckedAt: now,
          unavailableReason: undefined,
          lastError: undefined
        });
      }
      // The newest complete (non-draft/prerelease, fully-assetted) release is not newer than
      // what is installed, so nothing older in this descending list could be newer either.
      break;
    }
    return store.update({ phase: 'idle', lastCheckedAt: now, unavailableReason: undefined });
  } catch {
    return store.update({ phase: 'idle', unavailableReason: 'offline', lastCheckedAt: now });
  }
}
