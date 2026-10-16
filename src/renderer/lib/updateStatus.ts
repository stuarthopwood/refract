// Shared update-state wording (spec 006 "Installer and updates"): `updateUnavailableReasonText`
// used to live only in `StatusBar.tsx`; issue #569 reuses it verbatim for the profile menu's own
// update entry (spec 008 FR-021), so it is pulled out here rather than duplicated across the two
// files (`AGENTS.md` "No god files" reasoning applied to logic, not just file size).
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
