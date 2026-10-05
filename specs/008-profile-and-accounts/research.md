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
- **unverified, needs a real second account — not fabricated**: (a) the two-or-more-account
  `gh auth status --json hosts` array shape, and (c) `gh auth switch --hostname <h> --user
  <login>` / `gh auth logout --hostname <h> --user <login>`'s real stdout/stderr/exit codes, for
  both a matching and a non-matching `--user`. No placeholder JSON or guessed exit codes are
  recorded here for these three shapes; a later task with a real disposable/secondary GitHub
  account available must re-probe them before `ManageAccountsDialog.tsx`'s switch/sign-out code is
  written against an assumed shape.

**Rationale**: constitution Principle IV requires evidence before design for anything the spec
relies on; `gh auth login --web`'s own interactive browser flow and the two-or-more-account case
cannot be exercised without mutating a real credential store, which this planning pass
deliberately did not do, and which T001 could still not do safely tonight with only one real
account available.

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

## Decision 6: OMP provider sign-in/out — probe first, reuse the readiness pattern

**Decision**: task T002 (tasks.md) probes, before any User Story 3 implementation task, whether
`/login` and `/logout` are offered by a scratch `omp --mode rpc-ui` process's
`available_commands_update`, and if so what sending them as a `prompt` produces (an
`extension_ui_request` dialog, `command_output` text, or both), recording the result in
`docs/spike/FINDINGS.md` per constitution Principle IV. If the probe confirms a usable flow,
`src/main/ipc/accounts.ts`'s OMP section spins up a scratch, non-Session `OmpProcess` (the exact
construction `readiness.ts`'s `checkOmpSignedIn` already uses: a temp-dir cwd, started on demand,
stopped when the section closes) to call `get_login_providers` for reads and to send `/login`/
`/logout` and relay any resulting dialog through the existing `dialogs.ts` classifier
(contracts/omp-usage.md) over a new, non-Session pending-request channel.

**Fallback if the probe shows it is not possible** (`/login`/`/logout` absent from
`available_commands_update`, or the dialog it raises cannot be answered over rpc-ui): Manage
accounts' OMP section becomes read-only — it still lists provider sign-in state via
`get_login_providers` (already proven safe and working, FINDINGS item 15) — and signing in or out
shows an inline instruction to run `omp` in a terminal and use `/login`/`/logout` there, rather
than attempting an unsupported in-app flow. This is the conservative fallback recorded here so the
implementing task has a concrete instruction either way the probe comes out.

**Rationale**: the spec's own Assumptions flag this as unverified and require a probe before a
plan relies on it (constitution Principle IV); User Story 3 is Priority P2 and nothing else in
this spec depends on it, so a read-only fallback does not block Users Stories 1, 2, 4, or 5.

**Alternatives considered**: assuming the RPC-driven flow works and designing only that path —
rejected, directly against constitution Principle IV ("Features MUST NOT be designed around a
FINDINGS open item... until a probe resolves it").

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
