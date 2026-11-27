// Shared update-state wording (spec 006 "Installer and updates"). The bottom status bar is gone (#137):
// the profile menu's update entry, the avatar dot and the avatar's accessible name all read the one
// update state through the helpers here, so the three can never disagree.
import type { UpdateState } from '../../shared/updates'

/** FR-017/data-model.md "unavailableReason": `checker.rs`'s `Outcome::Unavailable` always
 * commits this alongside `phase: 'idle'`, never `'failed'` -- a GitHub-unreachable check is
 * "nothing new to report", not a failure, so it renders as its own idle-with-a-note state,
 * separate from the `'failed'` one. Plain-words explanation, never the raw enum value, matching
 * the Electron reference's `updateStatusText` (src/renderer/lib/updateActions.ts on
 * `origin/spec-006-impl`, mined/unfinished). */
export function updateUnavailableReasonText(reason: NonNullable<UpdateState['unavailableReason']>): string {
  switch (reason) {
    case 'not-installed':
      return 'GitHub CLI is not installed.'
    case 'not-signed-in':
      // Gate finding (round 3, Medium): matches `readiness.rs`'s own `check_github_cli` hint --
      // a portable-zip `gh` install may not be the `gh` a user's own terminal resolves, so
      // "Run gh auth login" could sign a different `gh` in, or find no terminal at all. Refract's
      // own sign-in flow (Manage accounts' "Sign in to GitHub…") always drives this exact binary.
      return 'GitHub CLI is not signed in. Sign in via Manage accounts.'
    case 'offline':
      return 'Could not reach GitHub.'
  }
}

/** The avatar dot: `pending` while an update is available, downloading or downloaded (accent), `failed` after a failure (red).
 * An idle state with an `unavailableReason` is "nothing new to report", so it shows no dot. */
export type UpdateIndicator = 'pending' | 'failed'

export function updateIndicator(state: UpdateState | null): UpdateIndicator | null {
  switch (state?.phase) {
    case 'available':
    case 'downloading':
    case 'downloaded':
      return 'pending'
    case 'failed':
      return 'failed'
    default:
      return null
  }
}

/** Appended to the profile button's accessible name, because the dot itself is decorative. */
export function updateAccessibleSuffix(state: UpdateState | null): string | null {
  switch (state?.phase) {
    case 'available':
      return 'update available'
    case 'downloading':
      return 'downloading update'
    case 'downloaded':
      return 'update ready to install'
    case 'failed':
      return 'update failed'
    default:
      return null
  }
}

/** What the one update item in the profile menu does when chosen. `busy` items ignore the choice. */
export type UpdateMenuAction = 'download' | 'update-now' | 'check' | 'busy'

export interface UpdateMenuEntry {
  action: UpdateMenuAction
  label: string
  /** Muted second line; absent when the label says enough. */
  detail?: string
  /** Shown on the right, for example `v1.4.0`. */
  version?: string
}

export function updateMenuEntry(state: UpdateState | null): UpdateMenuEntry {
  const version = state?.availableVersion ? `v${state.availableVersion}` : undefined
  switch (state?.phase) {
    case 'available':
      return { action: 'download', label: 'Download update', detail: 'Verified before it installs', version }
    case 'downloading':
      return { action: 'busy', label: 'Downloading update…', version }
    case 'downloaded':
      return { action: 'update-now', label: 'Restart to update', detail: 'Installs now, or when you quit', version }
    case 'installing':
      return { action: 'busy', label: 'Installing update…', version }
    case 'checking':
      return { action: 'busy', label: 'Checking for updates…' }
    case 'failed':
      return { action: 'check', label: 'Update failed. Check again', detail: state.lastError ?? 'Update failed for an unknown reason.' }
    default:
      return state?.phase === 'idle' && state.unavailableReason !== undefined
        ? { action: 'check', label: 'Check for updates', detail: updateUnavailableReasonText(state.unavailableReason) }
        : { action: 'check', label: 'Check for updates' }
  }
}
