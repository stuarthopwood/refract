# Terminal uses portable-pty and xterm.js

Status: Accepted. Date: 2026-11-28. Decider: Skippy, recommended options, delegated by Stuart (#3 grill 2026-11-10, Away Mode decisions 2026-11-28).

Issue #3 adds a right-pane **Terminal** panel with tabs per Session. The original plan assumed an Electron stack (`node-pty`, `koffi`, a main-process Job Object). That stack is deleted. The decision: Rust owns every shell and the renderer only draws one.

**Decision:**

- **Shell ownership.** The `portable-pty` crate (ConPTY on Windows 11) in `src-tauri` spawns, resizes, writes to and kills every shell. The renderer never spawns a process. No Node native module is added, and Principle V of the Constitution still bars shell and process plugin permissions.
- **Rendering.** `xterm.js` in the renderer draws the screen. It is a pure view: it holds no shell, and its own scrollback is a cache that a reload can lose.
- **Transport.** Output flows from Rust to the renderer over a Tauri channel (a streaming `ipc::Channel`), input and resize flow back through the one `refract_request` command. The plan phase proves in a probe whether the channel can be opened through `refract_request` without a second command (Principle IV); if it cannot, the single added command is an explicit Principle V amendment.
- **Lifetime.** A shell lives in the background until its tab closes, its Session ends, or Refract exits. Closing Refract ends every shell (the existing kill-on-close Job Object plus an explicit kill on exit). Relaunch restores each Session's tabs (name, working folder, shell kind) as fresh shells, never the old process.
- **Scrollback.** A bounded in-memory ring buffer per tab in Rust, so scrollback survives a Session switch and a renderer reload. It is never written to disk.
- **Agent access.** No terminal output reaches the model automatically. The only routes are the user's context-menu actions "Add to chat" and "Ask agent about this". The agent's own `bash` tool never runs through this terminal.
- **Shell choice.** PowerShell 7 (`pwsh.exe`) if installed, then Windows PowerShell, then `%COMSPEC%`.

## Considered options

- **`node-pty` in a Node sidecar.** Rejected: adds a native Node module and a second runtime that the Rust build removed on purpose.
- **Raw `CreatePseudoConsole` through the `windows` crate.** Rejected: `portable-pty` already wraps ConPTY and keeps a cross-platform door open at no cost.
- **Output as `app.emit` events.** Rejected for the data path: every chunk would be JSON-encoded and broadcast to every listener; a channel is point-to-point and binary-friendly.
- **Persisting scrollback to disk.** Rejected: terminal output can hold secrets, and the product rule is that it never touches disk.
- **Split view and one app-wide terminal.** Refused for v1; tabs per Session are the whole model.

## Consequences

- A new Rust dependency (`portable-pty`) and a new renderer dependency (`@xterm/xterm` with its fit addon) enter the build; both need an entry in `src-tauri/resources/THIRD_PARTY_NOTICES.md`.
- The renderer-callable surface stays at `refract_request` plus the opener route unless the probe forces the amendment above.
- Deferred, not decided: the `@terminal` mention (#465) and per-repo shell profiles.
