# Research: Profile and accounts

Each decision follows the spec's own Assumptions and the constitution. "Verified" entries were
checked live on the planning workstation (`gh` 2.102.0); "unverified" entries are the two Phase 1
probe tasks, scheduled before the work that depends on them (constitution Principle IV).

## Decision 1: GitHub CLI access via structured JSON, not text scraping

**Decision**: `src/main/github/cli.ts` reads account state with `gh auth status --json hosts`,
never by parsing the human-readable text output.

**Rationale**: verified live: `gh auth status --json hosts` on a signed-in machine returns
`{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com",
"login":"stuarthopwood","tokenSource":"keyring","scopes":"...","gitProtocol":"https"}]}}` — one
array per host, so the shape already supports more than one account per host without a second
command. `gh auth login`, `gh auth switch`, and `gh auth logout` all accept explicit `--hostname`
and `--user` flags per their `--help` text, so every mutating call can be unambiguous and never
fall back to an interactive disambiguation prompt Refract cannot answer.

**Alternatives considered**: parsing `gh auth status`'s plain-text output (the human-readable
form, e.g. "✓ Logged in to github.com account stuarthopwood (keyring)") — rejected: it is meant
for a terminal, not a stable contract, and the JSON form already exists and was verified to carry
every field Manage accounts needs (`login`, `active`, `state`).

## Decision 2: what the Phase 1 GitHub CLI probe still needs to confirm

**Decision**: task T001 (tasks.md) runs before User Story 2's implementation and confirms, with a
real second account if one can be added safely: (a) the exact `gh auth status --json hosts` array
shape with two or more accounts on one host (single-account shape is already verified, above);
(b) the exact stdout text `gh auth login --web` prints for the one-time code and its "press enter"
prompt, since FR-009 requires showing that progress; (c) what `gh auth switch --hostname <h>
--user <login>` and `gh auth logout --hostname <h> --user <login>` print and exit with, for both
the success case and a `--user` that does not match an existing account.

**T001 probe results (2026-10-05)**: only one real GitHub account (`stuarthopwood`) was signed in
on the workstation and no disposable/secondary account could be added without risking that
session, so this run only did what a single-account machine can verify safely.

- **re-verified**: `gh auth status --json hosts` still returns exactly the single-entry shape
  recorded in Decision 1 above —
  `{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com",
  "login":"stuarthopwood","tokenSource":"keyring","scopes":"copilot, gist, read:org,
  read:packages, repo, workflow","gitProtocol":"https"}]}}` — unchanged from the original
  planning-pass check; no drift since Decision 1 was written.
- **partially verified**: `gh auth login --web` was started and killed before completion, never
  switching or signing in. Command run: `GH_BROWSER=true timeout -s INT 6 gh auth login --web
  --hostname github.com --git-protocol https` (stdin/stdout not attached to a real terminal — this
  sandbox has no pty). Exact stdout:
  ```
  ! One-time code (5FCF-5515) copied to clipboard
  Open this URL to continue in your web browser: https://github.com/login/device
  ```
  then SIGINT fired (exit 124) before the code could be approved by anyone; `GH_BROWSER=true` was
  set first so no real browser window ever opened. Per `gh auth login --help`, the token is only
  written to the credential store "after completion" of the device flow, so killing the process
  pre-completion should never touch the stored credential — confirmed by re-running `gh auth
  status --json hosts` and `gh config get git_protocol` immediately after: both byte-for-byte
  identical to before the attempt, still showing only `stuarthopwood`, still `active: true`.
  **Still unverified**: the attached-terminal variant of this same prompt. `gh auth login --help`
  implies an interactive run may add a "press Enter to open in your browser" confirmation step
  that this non-tty sandbox never triggered (it printed the code and URL immediately instead), so
  FR-009's exact interactive-terminal wording is still open.
- **verified 2026-10-05, later the same day, via a scratch `GH_CONFIG_DIR`** (a throwaway config
  directory holding fake accounts in `hosts.yml`, with `GH_BROWSER` set to a no-op so no real
  browser ever opens — exercises the multi-account/switch/sign-out paths without a real second
  account and without ever touching `stuarthopwood`'s real login): (a) with two or three fake
  accounts on one host, `gh auth status --json hosts` returns exactly ONE array under
  `hosts["github.com"]`, each entry `{state, error?, active, host, login, tokenSource,
  gitProtocol}` — the array-of-entries shape this spec always assumed, now confirmed rather than
  inferred; an invalid token reports `state: "error"` with an HTTP 401 message (this is what
  Manage accounts' "Needs attention" row keys on, `state !== 'success'`), and `gh` lists the
  ACTIVE account first (the order changes after a switch). (b) a matching `gh auth switch
  --hostname <h> --user <login>` completed in ~145 ms, exits 0, with EMPTY stdout and
  `✓ Switched active account for <h> to <login>` on stderr; a `--user` that does not match any
  existing account on that host exits 1 with empty stdout and stderr `not logged in to <h>
  account <login>`. (c) logging out the ACTIVE account makes `gh` activate the first remaining
  account on that host in its own listing order — confirmed with 2 accounts, 3 accounts (active
  `carol` -> `alice`), and a non-alphabetical config (active `mid` of `zed`, `mid`, `abe` ->
  `zed`): `ManageAccountsDialog.tsx`/`SignOutDialog.tsx`'s successor rule ("first remaining
  account on the same host, in the CLI's listing order") matches reality. A matching `gh auth
  logout --hostname <h> --user <login>` exits 0 with empty stdout and stderr `✓ Logged out of <h>
  account <login>`, followed by `✓ Switched active account for <h> to <next>` when another
  account on that host became the new active one; a `--user` that does not match any existing
  account exits 1 with empty stdout and the same `not logged in to <h> account <login>` stderr
  `authSwitch` documents above — **re-verified live 2026-10-05** against the same scratch
  `GH_CONFIG_DIR`: `--hostname github.com --user nobody-test` (never present in the fake config)
  for both `switch` and `logout`, each exit 1 with stderr `not logged in to github.com account
  nobody-test`; a matching `--user bob-test` switch exits 0 with stderr `✓ Switched active
  account for github.com to bob-test`, and a matching `bob-test` logout exits 0 with stderr
  `✓ Logged out of github.com account bob-test` then `✓ Switched active account for github.com to
  alice-test`. This settles the one case the original single-account-workstation attempt could
  not reach; the three-shapes verification above is otherwise complete, so no part of
  `ManageAccountsDialog.tsx` ships against an assumed array shape, exit code, or stdout/stderr
  text any longer.

**Rationale**: constitution Principle IV requires evidence before design for anything the spec
relies on. The two-or-more-account case could not be exercised with `stuarthopwood`'s own real,
only, GitHub login without risking it — resolved not by waiting for a disposable account, but by
pointing `gh` at a scratch `GH_CONFIG_DIR` of fake accounts instead, which needed no real
credential store mutation at all.

**Alternatives considered**: shipping Manage accounts against the `--help` text's description
alone — rejected: the one-time-code line's exact wording is not in `--help` and must be read from
a real run before `ManageAccountsDialog.tsx`'s add-flow UI can parse it correctly.

## Decision 3: per-account profile data without switching the active account

**Decision**: `src/main/github/profile.ts` reads a short-lived token with `gh auth token
--hostname <host> --user <login>` and makes one bounded `https` request to
`https://api.github.com/user` with that token in an `Authorization` header, for every known
account (not only the active one), then discards the token immediately. Verified live:
`gh api user --jq '{login,name,avatar_url}'` returns
`{"avatar_url":"https://avatars.githubusercontent.com/u/43140296?v=4","login":"stuarthopwood",
"name":"Stuart Hopwood"}` for the active account; `gh auth token --help` confirms the `--hostname`/
`--user` flags needed to read a *non*-active account's token without an `gh auth switch` side
effect.

**Rationale**: FR-006 requires the display name and handle to come from "that account's GitHub
profile", and FR-008 lists every account in Manage accounts — using `gh api` directly would use
whichever account is currently active for every row, which is wrong for every non-active one.
Reading the token transiently and calling the API directly keeps Refract's "no stored token"
stance (FR-012, constitution V): the token exists only for the duration of one in-memory `https`
call.

**Alternatives considered**: calling `gh api user` after a temporary `gh auth switch`, then
switching back — rejected: it would flip the real active account twice per read, racing any
concurrent use of the GitHub CLI by the developer outside Refract, and would violate FR-013's
"active account never changes mid-request" guarantee from Refract's own UI.

## Decision 4: avatar validation and size cap

**Decision**: the avatar `https` request is bounded to host `avatars.githubusercontent.com` only
(the exact host GitHub's own `avatar_url` values point to); the final response host is checked
again after following any redirect (never trust the first `Location` blindly); the response must
have `Content-Type: image/png` or `image/jpeg` AND the first bytes must match that format's magic
number (`\x89PNG` or `\xFF\xD8`); the body is capped at 256 KiB, aborting the request if exceeded.
A response failing any check is rejected and the UI falls back to initials (FR-007).

**Rationale**: FR-007 requires a validated "small PNG or JPEG... from GitHub's avatar host"; 256
KiB is comfortably above GitHub's own largest served avatar size and is the concrete figure this
spec's own checklist (Notes) flagged as deferred to planning.

**Alternatives considered**: trusting the `Content-Type` header alone — rejected, since a header
can lie; a magic-byte check is cheap and catches a mislabelled or malicious response.

## Decision 5: avatar and name handed to the renderer as a `data:` URL, cached on disk

**Decision**: a validated avatar's bytes are base64-encoded into a `data:image/png;base64,...` (or
`jpeg`) string and returned over IPC; this string, plus the display name and handle, are persisted
in a new `profileCache.json` (data-model.md), keyed by `host/login`, refreshed opportunistically
(on the account list changing, on app start for the active account, lazily for others when Manage
accounts opens) — never on a timer.

**Rationale**: FR-006 forbids the renderer loading a remote image or making the request itself; a
`data:` URL is a local string, never a network request, satisfying constitution V exactly.
FR-015 requires showing the last cached name and avatar while offline; persisting the cache (not
only holding it in memory) means it survives an app restart that happens while offline too.

**Alternatives considered**: serving the avatar over a custom registered Electron protocol backed
by a file on disk — rejected as needless complexity for an image this small; a `data:` URL needs
no new protocol registration and is simpler to validate end-to-end (the same bytes that were
checked are the bytes handed over, with no separate file-read step that could serve something
else).

## Decision 6: OMP provider sign-in/out — confirmed unusable over rpc-ui; read-only fallback ships

**Decision**: task T002's probe (`docs/spike/omp-signin-probe.mjs`, FINDINGS item 43) confirmed
`/login` and `/logout` are absent from a scratch `omp --mode rpc-ui` process's
`available_commands_update` — on both a brand-new isolated profile (198 flattened commands) and
the real, fully-loaded, already-signed-in default profile (363 flattened commands), ruling out
`--profile` isolation as the cause. **The fallback branch ships, not the verified-usable branch**:
`src/main/ipc/accounts.ts`'s OMP section is read-only. It spins up the same scratch, non-Session
`OmpProcess` construction `readiness.ts`'s `checkOmpSignedIn` already uses (a temp-dir cwd,
started on demand, stopped when the section closes) only to call `get_login_providers` for reads
(already proven safe and working, FINDINGS item 15); `accounts.omp.signIn`/`signOut`
(contracts/ipc.md) unconditionally return error `unsupported`, and signing in or out shows an
inline instruction to run `omp` in a terminal and use `/login` there rather than attempting an
unsupported in-app flow. FINDINGS item 43 also found: `omp --help`/`omp login --help` document
`/login` as a real OMP slash command with its own terminal-only CLI counterpart (`omp login
[PROVIDER]`, "terminal counterpart of `/login`"), matching this decision's original anticipated
risk that the flow assumes a real terminal; no CLI `omp logout` counterpart exists in this
version, so the instruction text names only `/login`, never `/logout`, and never implies a
terminal sign-out command this probe did not find.

**Rationale**: constitution Principle IV requires evidence before design; the probe is decisive
rather than merely absence-of-something-tried, because it reproduced the identical zero-hit
result on the real, already-signed-in profile too (not only the never-used isolated one). User
Story 3 is Priority P2 and nothing else in this spec depends on it, so the read-only fallback does
not block User Stories 1, 2, 4, or 5.

**Alternatives considered**: assuming the RPC-driven flow works and designing only that path —
rejected, directly against constitution Principle IV ("Features MUST NOT be designed around a
FINDINGS open item... until a probe resolves it"); moot in hindsight since the probe ran and
confirmed the fallback is the only buildable path.

## Decision 7: one shared main-area view-switch store, reconciled with specs 003 and 004

**Decision**: `src/renderer/state/view-store.ts` (zustand) is a single shared primitive:

```ts
export type MainView = 'chat' | 'pull-requests' | 'settings' | 'manage-sessions'
export type SettingsSectionId = 'session-readout' // spec 007 adds 'appearance' later

interface ViewState {
  view: MainView
  repositoryId: string | null                // relevant for 'chat' | 'pull-requests' (spec 003's field)
  settingsSection: SettingsSectionId | null   // relevant for 'settings' (spec 004's field)
  openChat(repositoryId?: string): void
  openPullRequests(repositoryId: string): void   // spec 003's action
  openSettings(section?: SettingsSectionId): void // spec 004's action
  openManageSessions(): void                      // this spec's action
}
```

`App.tsx` reads `view` and renders `SettingsScreen` (spec 004), `PullRequestsView` (spec 003),
`ManageSessionsScreen` (this spec), or the existing `SessionList`+`ChatPane` pair, in the same slot
`showReadiness` already swaps on today. This spec's own tasks add the `'manage-sessions'` branch,
call `openSettings()` from the profile item's cog, and call `openManageSessions()` from the
profile menu.

**Rationale**: three sibling specs (003 Pull request management, 004 Session readout and
Settings, and this one) each independently need to swap the main area away from chat, and each
was being planned in the same session concurrently. A live coordination exchange with the agents
planning specs 003 and 004 (this session, 2026-10-02) surfaced that both had proposed the same
file path (`src/renderer/state/view-store.ts`) with incompatible field names (`mode` vs `view`);
the shape above was proposed to both and confirmed agreed by both, so exactly one store gets
built regardless of which spec's tasks create the file first — per spec 004's own confirmation,
its task builds the full four-member union up front with typed-but-inert stubs for the variants
it does not own, so neither spec 003 nor this spec needs to touch the store's shape again, only
add their own `App.tsx` render branch and feature component.

**Alternatives considered**: each spec inventing its own, separately named store (e.g.
`settings-view-store.ts`, `pr-view-store.ts`, `sessions-screen-store.ts`) — rejected: `App.tsx`
would need three independent pieces of "is some other view open" state to stay mutually exclusive
(opening Settings while Pull requests was open, say), which the single discriminated `view` field
avoids for free.

## Unknowns resolved

No `NEEDS CLARIFICATION` markers remain in the spec; the two items above (GitHub CLI multi-account
and sign-in-flow text, OMP sign-in over RPC) are the spec's own named Assumptions, carried into
Phase 1 as probe tasks rather than resolved by guessing.
