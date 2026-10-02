# Data model: Installer and updates

Field names follow `research.md`'s decisions and `contracts/ipc.md`. None of this spec's new
persisted state lives in `registry.json` or `settings.json` (spec 001); it adds one new file,
`updateState.json`, written the same way (`src/main/store/atomicJson.ts`).

## Release (not stored; read live from GitHub through `gh`)

One published version of Refract, per spec.md's Key Entities.

| Field | Type | Notes |
|---|---|---|
| `tagName` | `string` | For example `v0.2.0`; the maintainer workflow (`research.md` decision 8) requires this to equal `v${package.json version}`. |
| `version` | `string` | `tagName` without the leading `v`; compared with `compareVersions` (`research.md` decision 9). |
| `installerAssetName` | `string` | The `.exe` asset's file name. |
| `checksumAssetName` | `string` | The `.sha256` asset's file name. |
| `notesUrl` | `string` | The release's own GitHub page (opens in the system browser, FR-013). |
| `prerelease` | `boolean` | From `gh release view --json isPrerelease`. |
| `draft` | `boolean` | From `gh release view --json isDraft`. |

A release missing `installerAssetName` or `checksumAssetName`, or with `prerelease`/`draft` true,
is never surfaced as an available update (FR-019, FR-026).

## Dependency (readiness checklist row)

Reuses the existing `Check` shape (`src/shared/ipc.ts`, spec 001): `{ ok: boolean; found?: string;
hint?: string }`. This spec adds one new instance, `github`, and extends every instance's
meaning:

| Dependency | Checked by | `ok` means |
|---|---|---|
| `git` | existing `checkGit()` | `git --version` resolves on PATH (unchanged). |
| `omp` | existing `checkOmp()` | found and on the supported `18.4.x` line (unchanged). |
| `ompSignedIn` | existing `checkOmpSignedIn()` | unchanged (manual hand-off, FR-009). |
| `github` (new) | `checkGithubCli()` | `gh --version` resolves on PATH **and** `gh auth status` reports a signed-in account; never required for `allPass` (FR-008). |

## DependencyInstallProgress (event payload, not persisted)

One event per step of a dependency Install action (FR-006, FR-010).

| Field | Type | Notes |
|---|---|---|
| `dependency` | `'git' \| 'omp' \| 'github-cli'` | Which Install action this progress belongs to. |
| `phase` | `'downloading' \| 'running' \| 'done' \| 'failed'` | `'downloading'` is Refract's own HTTPS fetch of the vendor installer; `'running'` is the spawned installer process; `'done'` triggers an automatic `readiness.check()`; `'failed'` carries `detail`. |
| `detail` | `string?` | Set only on `'failed'`: an actionable reason (exit code, HTTP status, or a caught error's message), never a raw stack trace. |

## UpdateState (persisted: `updateState.json`, `src/main/store/updateState.ts`)

The spec.md Key Entity "Update" (notified → downloaded and checksum-verified → installed),
persisted so it survives a crash or an unexpected shutdown between steps (Edge Cases: "resumes the
next time Refract quits").

| Field | Type | Notes |
|---|---|---|
| `version` | `1` | Schema version, matching `registry.json`/`settings.json`'s own `version: 1` convention. |
| `phase` | `'idle' \| 'checking' \| 'available' \| 'downloading' \| 'downloaded' \| 'installing' \| 'failed'` | Default `'idle'`. |
| `availableVersion` | `string?` | Set once `phase` reaches `'available'`; the `Release.version` found by `UpdateChecker`. |
| `notesUrl` | `string?` | Set alongside `availableVersion` (FR-013). |
| `installerPath` | `string?` | Set once `phase` reaches `'downloaded'`: the verified installer's path under `app.getPath('userData')/updates/`. |
| `lastCheckedAt` | `string?` | ISO timestamp, updated on every `check()` call, successful or not (drives SC-004's "within 5 seconds of opening Settings or starting Refract" as a freshness signal for the badge). |
| `lastError` | `string?` | Set on `phase: 'failed'`: an actionable reason (FR-018); cleared on the next successful phase transition. |
| `unavailableReason` | `'not-installed' \| 'not-signed-in' \| 'offline'?` | Set instead of advancing past `'checking'` when GitHub access is unavailable (FR-017); cleared on the next check that can actually reach GitHub. |

### Phase transitions

```
idle --check()--> checking --(no update)--> idle
                           --(update found)--> available
                           --(gh unavailable/offline)--> idle, unavailableReason set
available --install()--> downloading --(checksum ok)--> downloaded
                                      --(checksum fails / download fails)--> failed
downloaded --(before-quit, normal quit)--> installing
installing --(next app start, version matches)--> idle
           --(next app start, version does not match)--> failed
failed --check()--> checking (retrying is always available; failed is not a dead end)
```

A `before-quit` that fires while `phase` is anything other than `'downloaded'` does nothing
update-related (FR-015: install only ever happens from a verified, downloaded state, and only at a
quit the developer already chose — never implied by any other phase).

## Readiness extension

`Readiness` (`src/shared/ipc.ts`, spec 001) gains one field:

```ts
export interface Readiness {
  git: Check;
  omp: Check;
  ompSignedIn: Check;
  github: Check; // optional dependency (FR-008); never affects `allPass`
}
```
