# Refract gives the agent tools through omp host tools, not a loopback MCP server

Epic #1304 lets an agent drive Refract: open its panels (#1193), list and message Sessions (#1858), create and nest Sessions (#1859), and more. Every slice needs a way to give the agent Refract-owned tools. On 2026-11-10, after a probe of omp 18.17.0 (`--mode rpc-ui`), Stuart decided how.

Rules:
- **Channel.** Refract registers tools with `set_host_tools` on every launch, before the first prompt, and serves `host_tool_call` frames with `host_tool_result` on the RPC stream it already reads. Each tool uses `loadMode: "essential"`, so the model calls it directly rather than reading it at `xd://<name>` first. A later `set_host_tools` replaces the whole set, so Refract always sends the full set.
- **Names.** Every tool starts with `refract_`, for example `refract_list_panels`, `refract_open_panel` and `refract_invoke_panel_action`, so none can clash with an omp tool.
- **Access.** Each launch registers only the tools that Session may use, filtered by role and depth (a child at the depth limit gets no `create_session`). Rust also checks every call against the Session id that owns the RPC stream, never against a tool argument.
- **Approval.** OMP has no per-tool approval field on a host tool definition, and an undeclared tool prompts in every mode except `yolo`. Each launch therefore passes a `--config` overlay with `tools.approval.<tool>: allow` for Refract's tools, so OMP does not prompt. Refract raises its own approval card, once, for a mutating action, and skips it in `yolo` like any other tool call. A call is never prompted twice.
- **Errors.** A failed call returns `host_tool_result` with `isError: true` and a short JSON body. It never shows a toast.
- **Cancel and disconnect.** `host_tool_cancel` drops the pending call and closes any card it raised. A process exit drops every pending call.

**Reserved, not built:** a loopback MCP server per launch (HTTP on `127.0.0.1`, an ephemeral port, a per-launch bearer token bound to one Session id). Use it only if a later omp release stops accepting host tools over RPC. Its tool names, access rule and approval rule would stay the same.

**Known limitation:** if omp ignores the `tools.approval` overlay for host tools, OMP's own `Allow tool:` prompt becomes the single approval for every Refract tool in ask mode, and Refract skips its card. The #1193 live check settles which case holds.

**Consequences:** `src-tauri/src/agent_tools/` owns registration, routing, timeout and cancel for every later slice, which add tools to a table rather than new transport. A change to omp's host-tool frames can break the channel, so the OMP release review (#689) checks them.
