# Data model: Profile and accounts

Extends specs/001-core-session-workspace/data-model.md. No change to `registry.json` or
`settings.json`. GitHub accounts and OMP provider state are never stored by Refract (FR-012) —
only a small, revalidated display cache is.

## Stored by Refract

### `profileCache.json`

```ts
interface ProfileCache {
  version: 1;
  accounts: Record<string, ProfileCacheEntry>; // keyed by `${host}/${login}`, e.g. "github.com/stuarthopwood"
}

interface ProfileCacheEntry {
  displayName: string | null;   // null falls back to the login everywhere a name would show (FR per Edge Cases)
  avatarDataUrl: string | null; // validated `data:image/png;base64,...` or `data:image/jpeg;base64,...`; null = show initials
  fetchedAt: string;            // ISO 8601; the moment this entry was last successfully refreshed
}
```

Rules:

- Lives in `app.getPath('userData')`, same directory as `registry.json`/`settings.json`, same
  atomic write-then-rename pattern (`atomicJson.ts`): write `profileCache.json.<pid>.<n>.tmp`,
  flush, rename over `profileCache.json`; a file that fails to parse is quarantined as
  `profileCache.json.corrupt-<timestamp>` and Refract starts with an empty cache.
- Never holds a GitHub access token (FR-012): only the two display fields above, both derived from
  a one-time profile/avatar fetch (research.md decisions 3-5).
- An entry is written whenever a fetch for that `host/login` succeeds; a failed or skipped fetch
  (offline, rate limited, rejected avatar) leaves the previous entry untouched, so FR-015's
  "last cached name and avatar" always means the newest *successful* read, not the newest attempt.
- An entry for an account the GitHub CLI no longer knows about (signed out, removed) is left in
  place rather than deleted immediately: it is simply never shown again once that account drops
  out of `accounts.github.list()`, and is naturally overwritten if the same login signs in again
  later. Refract does not grow this file unboundedly in practice, since the GitHub CLI itself
  only ever tracks a handful of accounts.

## Derived from the GitHub CLI (not stored by Refract)

### GitHubAccount

Read live on every `accounts.github.list()` call, never cached as a list (only its display data
is, above):

| Field | Source |
|---|---|
| `host` | `gh auth status --json hosts`'s key, e.g. `"github.com"` |
| `login` | that host entry's `login` |
| `active` | that host entry's `active` |
| `state` | that host entry's `state` (`"success"` or an auth-problem string) |
| `displayName` | `profileCache.json`'s entry for `host/login`, refreshed opportunistically (research.md decision 5); `null` until first fetched, in which case the UI shows `login` in its place |
| `avatarDataUrl` | same cache entry; `null` shows initials (FR-007) |

`gh auth status --json hosts` returning no `github.com` key (or failing because `gh` is not on
PATH) means no GitHub account is signed in: the profile item and Manage accounts both show the
signed-out state from User Story 1 (FR-004), and Manage accounts offers Sign in (or the Install
action from spec 006's readiness screen, when `gh` itself is missing — FR-014).

### OmpProviderState (User Story 3)

Read live from a scratch `OmpProcess`'s `get_login_providers` response (same shape
`readiness.ts`'s `signedInFailureHint` already reads):

| Field | Source |
|---|---|
| `id` | the provider's `id` from `get_login_providers`' `providers[]` |
| `authenticated` | that provider's `authenticated` flag |

Never persisted: this section always re-reads live state when Manage accounts' OMP section opens,
the same "nothing ever cached" rule `readiness.check()` already follows for its own checks.

## Held in memory (renderer)

### Account store state

```ts
interface AccountsState {
  github: GitHubAccount[];              // refreshed on open and on accounts:github-changed
  addFlow: GitHubAddFlowProgress | null; // non-null while User Story 2's add-account flow is running
  ompProviders: OmpProviderState[];      // refreshed when Manage accounts' OMP section opens
}

interface GitHubAddFlowProgress {
  code: string;            // the one-time code shown to the developer (FR-009)
  status: 'waiting' | 'completed' | 'cancelled' | 'failed';
  detail?: string;         // a failure reason, when status is 'failed'
}
```

Not persisted: a flow in progress when Refract restarts is simply gone; the developer retries
Add account.

## No change to existing entities

- `Session`, `Repository`, `Settings`, `SessionRuntime`, `TranscriptItem`, `PendingRequest`,
  `ConversationInfo` (specs/001) are unchanged by this spec.
- This spec's own non-Session dialog relaying (User Story 3's sign-in/out) reuses the existing
  `PendingRequest` union's shape (`src/shared/model.ts`) for its payload, scoped by a management
  request id instead of a `sessionId` (contracts/ipc.md, contracts/omp-usage.md) — it is not a new
  variant of `PendingRequest` itself, since it never belongs to a Session's transcript.
