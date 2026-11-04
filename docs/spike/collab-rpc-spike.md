# Spike: can an RPC Session host OMP `/collab`? (#1638)

Date: 2026-11-04. OMP under test: 18.15.0 (installed); source read at tag `v18.15.0`, and `main` re-checked for the one deciding fact (below). Probe: [`collab-rpc-probe.mjs`](./collab-rpc-probe.mjs) (isolated profile, unreachable keyless fake model, scratch cwd and session dir, secret-shaped env vars stripped, no model tokens spent; it never writes raw frames or links to disk).

## Recommendation: NO-GO for #1639 as written

A Session driven over OMP RPC cannot host `/collab` today. `/collab`, `/collab view` and `/collab stop` are TUI-only in OMP; over `--mode rpc-ui` (what Refract spawns) they are not commands at all, they are sent to the model as ordinary text. Nothing is created, no link exists, and `collab.autoStart` is ignored. #1639 must be re-grilled (as #1638 says) around one of the routes below before implementation. Do not build the popover against `/collab` over RPC.

## Evidence

Live run, `omp --mode rpc-ui` and `--mode rpc`, both identical:

| Check | Result |
| --- | --- |
| `get_available_commands` | 48 commands; `collab`, `join`, `leave` are not advertised |
| prompt `/collab status`, `/collab view`, `/collab`, `/collab stop` | each ack is `response success=true` with no `data`, then `agent_start`, then `message_start`/`message_end` for a **user** message whose text is the literal `/collab ...`. No `command_output` frame, no `agentInvoked:false`, no link, no participant info |
| `omp collab list --json` while the Session ran | 0 hosts (no room was published) |
| profile `collab.autoStart: view`, `rpc-ui`, no prompt, 8 s wait | 0 hosts, 0 frames mentioning collab |

Cause, from source (`v18.15.0`, `slash-commands/`): RPC and ACP only run builtins that define a text-mode `handle` (`acp-builtins.ts`: `if (!command?.handle) return false`, and `false` means "forward as a prompt"). The `collab`, `join` and `leave` specs in `builtin-collaboration.ts` define only `handleTui`. Room hosting is wired in `main.ts` into `InteractiveMode` (`mode.init({ autoStartCollab })`, `mode.collabController.autoStart()`), and the host (`collab/host.ts`) takes the interactive context (`ctx.statusLine`, `ctx.ui`, `ctx.showStatus`, `ctx.updatePendingMessagesDisplay`). RPC mode has no such object. `main` on 2026-11-04 (v18.16.0 is the latest release) still has `handleTui` and no `handle` for `collab`.

Consequence for Refract: a Session `prompt` of `/collab view` is not a no-op. It starts a model turn and the model sees the text, so Refract must never send it (token spend and a confusing transcript).

## The six questions

1. **Do `/collab` and `/collab view` work in an RPC session?** No (see above). No structured form exists; there is no frame to parse. The only machine-readable surface is out-of-process: `omp collab list --json` (metadata only: instanceId, pid, generation, sessionId, cwd, model, participants, access, relayConnected, inputRequired, busy) and `omp collab link <instanceId|pid> [--view] --json` (returns the link over authenticated local IPC). Both only see hosts that already exist, and only a TUI process creates one.
2. **Guests joined or left, room ended?** In a TUI host these are host-side notices (`session.emitNotice(...)`, "X left the collab session", "Collab ended: <reason>") and the registry's `participants`/`relayConnected`. No RPC frame carries them. Not observable here: no room could be created.
3. **Do guest prompts, interrupts and approval answers reach the Session as RPC events?** Unverified live (no room). From source the host injects guest prompts with `session.promptCustomMessage` and aborts with `session.abort`, and broadcasts agent events to guests from `session.subscribe`, so an RPC Session would normally emit the usual events. The guest `ui-response` path answers host `select`/`editor` requests that the TUI raised, not RPC `extension_ui_request`s, so approval parity with Refract's chat is unproven. The conclusion is conditional on a future OMP design.
4. **Does `/collab stop` revoke the link? Does the room survive a restart?** Not testable (no room). From `omp://collab.md` and source: `stop` ends the room (guests get `bye`) and withdraws the registry entry; each `start` generates a fresh room id, 32-byte key and 16-byte write token (`crypto.getRandomValues`), so a new start never revives an old link. Rooms follow the session, not the process: `/new`, `/resume`, `/fork` stop the current room first, and the host's keys exist only in the host process memory, so a process exit or restart ends the room. Caveat: with `collab.autoStart` set, the same process hosts again under a new link.
5. **Is `collab.autoStart` honoured in RPC? How to force it off?** Not honoured: measured (0 hosts with `autoStart: view`) and by wiring (only `InteractiveMode` starts it). If #1639 chose to spawn Sessions in a mode that does honour it, Refract would have to pass a per-process override or keep it `off` in the isolated profile; never rely on user config.
6. **Refract-styled phone client (follow-up assessment).** The guest protocol is `COLLAB_PROTO = 3` (`@oh-my-pi/pi-wire`, MIT): it was bumped twice (v1 inline welcome, v2 `snapshot-chunk`, v3 `ui-request`) and the host rejects any other version at `hello`, so a custom client breaks on every bump and must track OMP releases. Guest frames: `hello`, `prompt`, `ui-response`, `abort`, `agent-cmd`, `fetch-transcript`; host frames: `welcome`, `snapshot-chunk`, `entry`, `event`, `state`, `bus`, `agents`, `ui-request`, `ui-request-end`, `transcript`, `bye`, `error`. `collab.webUrl` must be `https://` (localhost may be `http://`), no query or fragment; the room link rides in the URL fragment. A custom client means hosting a web app that receives the room key in the page, so a compromise or a third-party script on that origin exfiltrates the key (what the stock `my.omp.sh` client also risks, but Refract would own it). **Recommendation: do not file it now.** Revisit only after OMP exposes hosting to RPC and the frame protocol is stable; if filed, require pinning to a tested `proto`, a strict CSP, `Referrer-Policy: no-referrer`, no third-party scripts, and no analytics.

## Security assessment

- **Credential.** The link (room id plus 32-byte AES-256-GCM key, plus a 16-byte write token in a full link) is the only credential; a view link holds the bare key. Anyone who sees it (QR shoulder-surf, clipboard history, screenshot, screen share, process listing, log line, browser history of the guest) has access until Stop. Links never appear in `omp collab list`; they only travel through `omp collab link` IPC and the TUI.
- **Blast radius, Full control.** A writable guest can read the whole session including the back-transcript, prompt the agent (the model sees text verbatim, names are display-only), interrupt, drive subagents (chat, kill, revive), and answer host `select`/`editor` dialogs. That means anything the Session can do on this machine through its tools, including approving its own approval prompts. Guests cannot run host-only slash commands (`/model`, `!`, `$`, `/compact`). View only still discloses all file contents, command output and secrets that ever entered the transcript.
- **Relay trust.** Default relay is `wss://my.omp.sh` (`DEFAULT_RELAY_URL`). By the OMP docs and wire code, frames are sealed with AES-GCM before they reach the socket; the relay sees room ids, connection counts, ciphertext sizes and the 4-byte routing prefix. The relay source is not published (Go, closed), so content-blindness is a documented claim, not auditable. The relay also sees client IPs and timing. A malicious relay cannot read content but can drop or delay frames; a leaked link is not defended by the relay.
- **Write enforcement.** The host verifies the write token with `timingSafeEqual` at `hello` and rejects mutating frames from peers without it. Good, but it is a client-supplied bearer token inside the same secret.
- **Revocation and expiry.** No time-based expiry and no per-guest revoke: the only controls are Stop (and replacing a room by changing access), session switch, and process exit. A room can also end on its own (relay close, send backlog limit).
- **Refract-side exposure.** Refract currently has no collab code. Anything that carries the link (Tauri events, logs, crash reports, the chat transcript, clipboard, devtools) widens the credential's reach.

## Routes forward and required mitigations for #1639

Routes, in order of preference (all need a re-grill):
1. **Upstream OMP change** (preferred): ask for a text-mode/RPC `/collab` handler or dedicated RPC commands (`collab_start { access }`, `collab_status`, `collab_stop`) with structured frames (`collab_state { access, links, participants, relayConnected }`, ended reasons) and `collab.autoStart` forced off in RPC. Blocked until OMP ships it.
2. Refract hosts its own room (Rust speaks `COLLAB_PROTO = 3` as host: AES-GCM sealing, welcome/snapshot, guest `prompt`/`abort`/`ui-response` routing into the RPC Session). Large, tracks OMP wire changes, and makes Refract the security owner. Not recommended.

Whichever route: (a) never log, persist, put in an error string, emit as a Tauri event outside the one popover channel, or screenshot-test the join link; keep it in Rust memory and zero it on Stop; (b) default View only, with Full control behind an explicit confirmation naming the blast radius ("guests can run tools on this machine and approve prompts"); (c) end on Stop, Session close, archive and app exit, and on restore force it off; (d) badge the Session row and header with text and the guest count; (e) never send `/collab ...` as a prompt over RPC; (f) show guest count and joined/left from a structured source, not scraped text; (g) tell users the default relay is third-party and the link is a bearer secret; (h) a bounded self-test per OMP version bump that fails if collab exposure changes.

## Open items

- Frame behaviour with real guests (events, approvals, restart) was not exercised: no host could be created over RPC, and the issue forbids joining a live room from here. Re-run `collab-rpc-probe.mjs` when OMP gains an RPC collab surface.
- `/collab stop` revocation is from source and docs, not a live room.
