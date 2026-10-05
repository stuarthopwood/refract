# Contract: OMP wire usage — Profile and accounts (User Story 3)

Extends specs/001-core-session-workspace/contracts/omp-usage.md. This spec's only new OMP usage
is Manage accounts' OMP provider section; every other story in this spec never talks to OMP
directly.

## The management connection

Not a Session: `accounts.omp.list()`, `.signIn()`, and `.signOut()` each need a running
`omp --mode rpc-ui` process, but none of them belongs to any Repository's worktree. The main
process starts one scratch `OmpProcess` the same way `readiness.ts`'s `checkOmpSignedIn` already
does for its own check:

- `cwd`: a freshly created temp directory (`fs.mkdtemp(path.join(os.tmpdir(), 'refract-accounts-'))`),
  never a Session's worktree.
- `approvalMode: 'ask'` (irrelevant here: no tool call is ever made on this connection).
- `sessionId: 'accounts-probe'` (a fixed label, not a real Session id; it never reaches the
  registry or the session list).

Started lazily when Manage accounts' OMP section is first opened or a sign-in/out is requested,
and stopped (`proc.stop()`, then the temp dir removed) once the section closes or the action
finishes — never kept running in the background, and covered by the same kill-on-close Job Object
every `omp` child joins (constitution Principle III), so it can never outlive Refract either.

## Reads: `get_login_providers`

Already proven safe and working (specs/001 FINDINGS item 15, `readiness.ts`'s
`signedInFailureHint`): `{ type: 'get_login_providers', id: '' }` returns
`{ providers: [{ id, authenticated, ... }] }`. `accounts.omp.list()` calls this once per open and
maps it straight to `OmpProviderState[]` (data-model.md).

## Sign-in/out: resolved -- not drivable over rpc-ui (T002); read-only fallback shipped

**Result (2026-10-05, T002)**: `/login`/`/logout` do not appear in the management connection's
`available_commands_update` (docs/spike/FINDINGS.md item 43, research.md decision 6), on either an
isolated or the real signed-in profile. The fallback below is what shipped; the probe's own
original questions are kept here for the record:

1. Whether `/login` and `/logout` appear in the management connection's `available_commands_update`.
2. If so, what sending `{ type: 'prompt', message: '/login', id: '' }` produces: an
   `extension_ui_request` (and if so, its `method` and whether `dialogs.ts`'s existing classifier
   — approval vs. question by the `Allow tool:` title prefix — correctly falls through to treating
   it as a question/select, or needs a dedicated case), plain `command_output` text (for example a
   URL and device code to read out, analogous to `gh auth login --web`), or both.
3. The same for `/logout`, including whether it asks the developer to choose which provider when
   more than one is signed in.
4. Whether the dialog(s) raised can actually be driven to completion from a scratch, non-Session
   connection, or whether OMP's `/login` flow assumes a real terminal (for example waiting on a
   key press OMP's own CLI UI provides that rpc-ui does not surface as an answerable request) —
   if the flow stalls with no answerable request, it is unusable over rpc-ui and the fallback
   below applies.

**If verified usable**: `accounts.omp.signIn`/`signOut` send the prompt, classify any resulting
`extension_ui_request` with the existing `classifyDialog`/`buildDialogResponse`
(`src/main/omp/dialogs.ts`, unchanged), and surface it over `accounts:omp-request` /
`accounts.omp.answer` (contracts/ipc.md) instead of the Session-scoped `request:pending`/
`chat.answer` channel, since there is no Session involved. `command_output` text (for example a
URL to open) is relayed as part of the same request payload's `details`, reusing the `approval`
variant's `details: string[]` field for plain informational lines when no actual answer is
required (for example "Open https://github.com/login/device and enter ABCD-1234").

**Not verified usable (shipped)**: `accounts.omp.signIn`/`signOut` return error `unsupported`
(contracts/ipc.md); Manage accounts' OMP section is read-only (`get_login_providers` only) and
shows "To sign in to another provider, run `omp login` in a terminal." with a Copy command button
-- never a Sign in/out control, and never mentions `/logout` (no terminal counterpart was found
for it either).

## Commands this spec does not use

Every other OMP command and frame type is exactly as specs/001's contracts/omp-usage.md already
documents; this spec introduces no new Session-scoped usage.
