# Plan mode is an approval policy, not a sandbox

Status: Accepted. Date: 2026-11-26. Decider: Stuart (#2116 and #1946).

omp has no plan toggle under rpc-ui and its own plan-mode guard never runs there, so Refract's Plan working mode enforces "plan only" through the per-tool approval policy omp honours on the launch `--config` overlay (`src-tauri/src/omp/plan_overlay.rs`, FR-152).

**Decision:**

- A plan launch adds `plan-mode-approval.yml` to `--config`. `write`, `edit` and `ast_edit` are `deny`, which holds under every approval mode, `yolo` included.
- Every other tool omp 18.22.2 declares at the `write` or `exec` tier is `prompt`: `bash`, `eval`, `browser`, `computer`, `task`, `github`, `debug`, `lsp`, `hub`, `security_scan`, `security_publish`, `manage_skill`, `learn`, `context_notes`, `new_context`, `generate_image`, `tts`, `vibe_spawn`, `vibe_send`. A tool whose tier depends on its arguments is listed whole, because the overlay is keyed by tool name. These ask instead of being denied: `bash` cannot be told from a file change by name, and a denied `task` would block read-only exploration. `task` prompts by design for that reason. `ssh` is not a tool in omp 18.22.2, so it has no key.
- If the overlay cannot be written, the launch fails with an error. Refract never starts a plan-mode process without the deny.
- `ssh://` reads, MCP tools and extension tools are not gated by the overlay; it keys only omp's built-in tool names.

**Consequences:**

- Plan mode is a strong default, not a sandbox. A tool the user allowlisted in omp's own settings, a `bash` command the user approved with "remember", and an MCP tool or `xd://` device that writes can all still change files in plan mode.
- The hidden plan instruction and the Plan role steer the agent; only the `deny` keys are a hard stop.
- omp 19 or a new built-in tool needs the key list re-checked; `plan_overlay_denies_every_write_tool_and_asks_for_every_exec_or_write_tool` pins the current set.
