# Pinion Constitution

## Core Principles

### I. OMP Is the Engine, Pinion Is the Host

- Pinion MUST drive OMP only through `omp --mode rpc-ui` over stdio: one OMP child process per
  session, one session per git worktree. Pinion MUST NOT embed the OMP SDK, require Bun, or use
  ACP.
- Every launch MUST load OMP's full feature set (skills, extensions, MCP servers, rules). Pinion
  MUST NOT pass `--no-extensions`, `--no-skills`, `--no-tools`, `--no-rules`, or `--no-ui`.
- Every launch MUST pass `--approval-mode` explicitly, set from Pinion's global Approval mode
  setting (Ask = `always-ask`, Edit freely = `write`, Auto = `yolo`), so that OMP's own
  `tools.approvalMode` never decides. OMP has no RPC command to change the mode on a live
  process; a change applies once the session is idle (`session_settled`, not just `prompt_result`,
  because background jobs can wake the agent after it yields), by restarting the process and
  reattaching the same saved session per Principle III (FINDINGS item 9).
- Pinion MUST NOT reimplement behaviour OMP exposes over RPC. It supplies natively only the
  commands absent over RPC: `/plan`, `/fork`, `/resume`, `/new`, `/settings`, `/pause`,
  `/plan-review`, and `/btw`. `/new` maps to `new_session`; `/resume` maps to the reattach rule
  in Principle III.

Rationale: the transport spike (`docs/spike/FINDINGS.md`) selected rpc-ui because it keeps
skills, extensions, MCP, approvals, and `ask` working. The SDK cannot surface approvals, and ACP
sessions do not survive a process restart.

### II. RPC Wire Contract

- The prompt payload field is `message`. Pinion MUST NOT send `text`; OMP accepts it silently
  and fails with an opaque TypeError.
- After `abort`, Pinion MUST wait for `session_settled` (or `get_state` `isSettled: true`)
  before sending another prompt. The abort acknowledgement does not mean idle.
- Pinion MUST NEVER forward literal `/btw ...` text; OMP runs it as a normal, persisted turn.
  Side chat MUST go through the bundled extension built on `ctx.runEphemeralTurn`
  (`docs/spike/btw-ext.ts`).
- Tool approvals and `ask` both arrive as `extension_ui_request` with `method: "select"`. A
  title starting with `Allow tool:` is a tool approval (options `Approve` and `Deny`); every
  other `select` is an `ask` question. `ask` loses headers, previews, notes, and images over RPC.
- Pinion MUST answer every `select`, `confirm`, `input`, and `editor` request, with a value or
  `cancelled: true`. An unanswered dialog stalls the turn.
- Pinion MUST send only slash commands listed in the latest `available_commands_update` or in
  the native set of Principle I. OMP does not reject unknown `/foo` text; it sends it to the
  model.
- Local-only commands (`agentInvoked: false`) emit no `prompt_result`, and their
  `command_output` can arrive before or after the acknowledgement.
- A turn's answer is final at its `prompt_result`; the session is finished only at
  `session_settled`.
- After the `ready` frame, Pinion MUST negotiate protocol v2 and reassemble `rpc_chunk` frames.

### III. Session and Process Lifecycle

- Pinion lists saved sessions by scanning `*.jsonl` files in the session directory; RPC has no
  list-sessions command.
- To reopen a saved session after an app restart, Pinion spawns a fresh process in the session's
  worktree and binds it by file path: `--resume <sessionFile>` at launch, or `switch_session`
  with `sessionPath` in a running process (FINDINGS C16). Pinion MUST confirm every reattach by
  matching `get_state` `sessionFile` and `messageCount` against the saved session, because
  `switch_session` to a missing path succeeds with an empty session.
- Every OMP process MUST be spawned with the session's own worktree as its cwd. `switch_session`
  to a session recorded under a different cwd is cancelled and leaves the process on an empty
  session (FINDINGS C16, item 5).
- Pinion stops a session by closing its stdin and reading stdout until the process exits, and
  force-stops it with `taskkill /PID <pid> /T /F`. No `omp` process may outlive a normal exit.
- Pinion MUST record the pid and start time of every process it spawns, and on start MUST stop
  any recorded process still running from a previous run, after confirming the pid still names
  the same `omp` process. A force-killed Pinion cannot run `taskkill`; the
  child exits on its own when its stdin closes (FINDINGS item 10), but that does not cover
  subprocesses of a running tool.

### IV. Evidence Before Design

- Every OMP behaviour a Pinion feature depends on MUST be verified on the supported OMP version
  and recorded in `docs/spike/FINDINGS.md`, or labelled unverified in the spec that relies on it.
- Features MUST NOT be designed around a FINDINGS open item, such as the `branch` entry id rule
  or `/wt` behaviour, until a probe resolves it.
- The supported OMP version is 18.4.4. Raising it requires rerunning
  `docs/spike/resume-probe.mjs` on the new version and rechecking the FINDINGS rows Pinion
  relies on.

### V. Electron Security Baseline

- Every `BrowserWindow` MUST set `contextIsolation: true`, `nodeIntegration: false`, and
  `sandbox: true`.
- Only the main process spawns processes or touches the file system and git. The renderer
  reaches them through a typed, allowlisted API exposed from the preload with `contextBridge`.
- Agent, tool, and file output is untrusted. The renderer MUST NOT inject it as raw HTML, and
  markdown MUST be rendered through a sanitiser.
- App windows MUST NOT load remote content. External links open in the system browser.

## Platform and Stack

- Windows 11 is the only supported and tested OS for v1. OS-specific process control lives in
  one main-process module so other platforms can be added later.
- Electron main and preload processes plus a Vite + React renderer, all in TypeScript with
  `strict: true`.
- OMP runs as a child process over stdio, so the app needs no Bun. The side-chat extension ships
  with the app and loads with `--extension <path>`.

## Development Workflow

- Features flow through Spec Kit: `/speckit.specify`, `/speckit.plan`, `/speckit.tasks`,
  `/speckit.implement`, then `/speckit.converge`.
- Pinion is a prototype: speed of development comes first, and automated tests are not
  required. A feature is verified by running the app and exercising the changed path.
- Typecheck and production build MUST pass before a change lands on `main`.

## Governance

- This constitution overrides other practice in this repository. Every plan MUST pass the
  Constitution Check gate in `.specify/templates/plan-template.md`; any violation needs a row in
  that plan's Complexity Tracking table.
- Amendments go through `/speckit.constitution` with a semantic version bump: MAJOR for removing
  or redefining a principle, MINOR for a new principle or section or materially expanded
  guidance, PATCH for wording.
- A change to a Principle II or III rule MUST cite the FINDINGS row or probe result behind it.

**Version**: 1.3.0 | **Ratified**: 2026-09-30 | **Last Amended**: 2026-09-30
