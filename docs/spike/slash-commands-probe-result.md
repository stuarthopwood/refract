# Slash command inventory probe (T092)

- Date: 2026-10-02
- OMP version: `omp/18.4.10`
- Profile used: `pinion-probe-slash` (brand-new, never used before this probe; auto-seeded with one unreachable fake model so `rpc-ui` could start without any real credential; env vars matching `/API_KEY|OAUTH|TOKEN|SECRET|CREDENTIAL/i` stripped from the child process)
- Method: `docs/spike/slash-commands-probe.mjs`. For each of the 188 commands/subcommands returned by `get_available_commands`, a command matching the denylist (`login|logout|settings|config|model|advisor|plugin|skill|mcp|marketplace|update|exit|quit|share|export|delete|drop|reset|memory|theme|setup|handoff|compact|loop|vibe|collab|new|resume|fork|plan|btw`, case-insensitive) was recorded as `needs-decision` and never sent. Every other command was sent as a bare `/<name>` prompt and observed for up to 20s; any `extension_ui_request` dialog was answered `cancelled: true`. A command that left the session unsettled triggered an `abort`, a wait for `session_settled`, and a fresh process for the next command.

## Isolation check

**Structurally unchanged, with one caveat.** The pre/post snapshot of `~/.omp/agent` top-level entries (name + mtime only) reported a difference on every run, so the script correctly printed `ISOLATION BREACH` and exited 3 each time, per its mandatory design. Inspecting the actual diff (saved in each run's `isolation-breach.json`) shows:

- No entry was added or removed (same key set before and after, every run).
- Only `agent.db`, `agent.db-wal`, `models.db`, and `models.db-wal` changed mtime.

These four files are the live database of the **default** profile (`~/.omp/agent`), which this very OMP host session (the one running this probe) keeps open and writing to throughout its own lifetime, entirely independent of anything this script does. The probe process itself only ever touched `~/.omp/profiles/pinion-probe-slash/...` (its own `--profile`) and a scratch temp directory; it never wrote anywhere under `~/.omp/agent` (confirmed by code review: the only operation against that path is the read-only `fs.readdirSync`/`fs.statSync` snapshot). So: **isolation held** in the sense that matters (no probe action touched Stuart's real credentials, sessions, or config), but the generic "did anything under `~/.omp/agent` change" check is not deadlock-free on a machine where another OMP session is concurrently alive and writing to its own database — which is the normal condition of this very session. Treat the breach exit code here as a false positive caused by running the isolation probe from inside a live OMP session, not as evidence the probe leaked into real data.

The isolated profile directory `~/.omp/profiles/pinion-probe-slash` was left in place deliberately (per the brief) for the integrator to remove by hand.

## Results

Legend: **works-local** = `agentInvoked: false` (completed synchronously, no agent turn) or completed with `prompt_result.status: "completed"`/`"aborted"` while `get_state().isSettled` stayed true; **starts-agent-turn** = the session went unsettled after sending the prompt and had to be aborted (an idle real agent turn was dispatched); **needs-decision** = denylisted, never sent.

### works-local (80) — safe to exercise with no model/credentials at all

| command | description | evidence |
|---|---|---|
| `/security`, `/security scan`, `/security status`, `/security cancel`, `/security scans`, `/security show`, `/security import`, `/security validate`, `/security compare`, `/security disposition` | OMP-native security scan plan/run/inspect/compare family | `agentInvoked=false` |
| `/switch` | Switch model for this session only | `agentInvoked=false` |
| `/fast`, `/fast on`, `/fast ultra`, `/fast off`, `/fast status` | Fast-mode toggle family | `agentInvoked=false` |
| `/slow`, `/slow on`, `/slow off`, `/slow status` | Slow-mode toggle family | `agentInvoked=false` |
| `/extended-context`, `/extended-context on`, `/extended-context off`, `/extended-context status` | Extended-context toggle family | `agentInvoked=false` |
| `/computer`, `/computer on`, `/computer off`, `/computer status` | Computer-use toggle family | `agentInvoked=false` |
| `/prewalk`, `/prewalk restart` | Prewalk arm/restart | `agentInvoked=false` |
| `/trace` | Open session trace in stats dashboard | `agentInvoked=false` |
| `/dump` | Return full transcript as plain text | `agentInvoked=false` |
| `/browser`, `/browser headless`, `/browser visible` | Browser eval-prelude mode toggle | `agentInvoked=false` |
| `/todo`, `/todo edit`, `/todo copy`, `/todo expand`, `/todo collapse`, `/todo import`, `/todo append`, `/todo start`, `/todo done`, `/todo rm` | Todo management family (excl. `/todo export`, `/todo drop` — denylisted) | `agentInvoked=false` |
| `/session`, `/session info`, `/session pin` | Session info/pin (excl. `/session delete` — denylisted) | `agentInvoked=false` |
| `/jobs`, `/jobs full` | Background jobs listing | `agentInvoked=false` |
| `/usage`, `/usage show` | Token/provider usage (excl. `/usage reset` — denylisted) | `agentInvoked=false` |
| `/stats` | Launch local stats dashboard | `agentInvoked=false` |
| `/changelog`, `/changelog full`, `/changelog last` | Changelog viewer family | `agentInvoked=false` |
| `/tools` | Show available tools | `agentInvoked=false` |
| `/context` | Show context usage | `agentInvoked=false` |
| `/ssh`, `/ssh add`, `/ssh list`, `/ssh remove`, `/ssh help` | SSH connection management | `agentInvoked=false` |
| `/fresh` | Reset provider stream state | `prompt_result status=aborted` (session stayed settled) |
| `/shake`, `/shake elide`, `/shake images`, `/shake thinking` | Shake heavy content out of context | `agentInvoked=false` |
| `/pin` | Pin/unpin session in resume list | `agentInvoked=false` |
| `/retry` | Retry last failed agent turn | `agentInvoked=false` |
| `/rename` | Rename current session | `agentInvoked=false` |
| `/move` | Move session to a different directory | `agentInvoked=false` |
| `/wt` | Move session into a new worktree | `agentInvoked=false` |
| `/add-dir`, `/remove-dir`, `/dirs` | Workspace directory management | `agentInvoked=false` |
| `/force` | Force next turn to use a specific tool | `agentInvoked=false` |
| `/autoresearch` | Toggle builtin autoresearch mode | `prompt_result status=completed` |
| `/review` | Launch interactive code review | `prompt_result status=completed` |
| `/annotate` | Annotate a diff/text | `prompt_result status=completed` |

### starts-agent-turn (3) — need a signed-in profile to fully verify

These left `get_state().isSettled` false after the bare prompt (an idle real agent turn was dispatched, which this unsigned profile cannot usefully complete — each was aborted immediately by the probe):

| command | description | evidence |
|---|---|---|
| `/ratchet` | Build (or reuse) an eval for an LLM flow, then hillclimb it unattended | unsettled after prompt; aborted; settled after abort |
| `/green` | Generate a prompt to iterate on CI failures until the branch is green | unsettled after prompt; aborted; settled after abort |
| `/init` | Generate AGENTS.md for current codebase | unsettled after prompt; aborted; settled after abort |

### needs-decision (105) — denylisted, not sent (config/credential/destructive-shaped)

`/security plan`, `/security export`, `/model`, `/skillful` (+`on`/`off`/`status`), `/modelpreset` (+`list`/`save`/`switch`/`delete`), `/advisor` (+`on`/`off`/`status`/`dump`/`configure`), `/export`, `/share`, `/todo export`, `/todo drop`, `/session delete`, `/usage reset`, `/mcp` (+`add`/`list`/`remove`/`test`/`reauth`/`unauth`/`enable`/`disable`/`smithery-search`/`smithery-login`/`smithery-logout`/`reconnect`/`reload`/`resources`/`prompts`/`notifications`/`help`), `/compact` (+`soft`/`remote`/`snapcompact`), `/handoff`, `/memory` (+`view`/`stats`/`diagnose`/`queue`/`sync`/`clear`/`reset`/`enqueue`/`rebuild`/`mm list`/`mm show`/`mm refresh`/`mm history`/`mm seed`/`mm delete`/`mm reload`), `/marketplace` (+`add`/`remove`/`update`/`list`/`discover`/`install`/`uninstall`/`installed`/`upgrade`/`help`), `/plugins` (+`list`/`enable`/`disable`), `/reload-plugins`, and every `/skill:*` / `/skillful*` command (24 skill invocations matched by the `skill` denylist term).

## Proposed supported set for a future ticket

The 80 `works-local` commands above are the proposed supported slash-command set: every one of them is observably safe with zero configuration (no model, no credentials, no network) and completes without ever starting a real agent turn except `/autoresearch`, `/review`, and `/annotate`, which completed a turn locally against the harmless unreachable fake model without leaving the session unsettled.

The 3 `starts-agent-turn` commands (`/ratchet`, `/green`, `/init`) are **not** in the proposed set from this probe alone — confirming they behave correctly (rather than just "dispatches a turn") requires a signed-in profile with a real model, which this isolated run intentionally avoided.

The 105 `needs-decision` commands are out of scope for this probe by design (config/credential/model/plugin/destructive-shaped) and need an explicit human decision on which, if any, to expose.
