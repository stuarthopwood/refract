# Refract owns the ask tool

Status: Accepted. Date: 2026-11-22. Decider: Stuart (#1990 grill).

Epic #1990 needs per-option notes, several recommended options, and a reason per option on the **Question card**. OMP's RPC ask wire (18.22.2) carries none of them: `AskAnswer` is `{id, selectedOptions, customInput?}`, RPC mode has no `ui.formDialog`, so the native `ask` tool falls back to one field at a time and drops option notes. Refract ships its own blocking ask tool, `refract_ask`, instead of waiting for OMP.

**Decision:**

- `refract_ask` is a Refract host tool on the [ADR 0007](0007-agent-tool-channel.md) channel, beside `refract_checklist`. OMP has no timeout on host-tool calls, so the call waits for the developer.
- Native `ask` is off in every Refract Session: the per-launch `--config` overlay (`src-tauri/src/agent_tools/overlay.rs`) sets `ask.enabled: false` and pre-approves `refract_ask`. If the overlay cannot override the setting, a `--tools` allow-list is the fallback. Plain `omp` outside Refract keeps its native `ask`.
- Input: the native `ask` shape plus optional per-option `recommended` and `reason`; the question-level `recommended` index goes. Single-choice allows at most one recommended option; multi-select allows several.
- Result: numbered plain text Refract composes, one entry per question with the quoted question, the picked options by letter and label, "(recommended)" where it applies, each note on its own line under its option (at most 1000 characters), and "Typed:" for free text.
- No timer. The card waits until the developer answers or cancels, or the turn is aborted; cancel and abort return a plain cancelled result. Away Mode stays with #2031.

**Considered options:**

- Wait for OMP (can1357/oh-my-pi#20156, RPC `formDialog`; #20157, `askDialog` per-option fields). Rejected: notes stay blocked for an unknown time.
- A hybrid with both tools and prompt steering. Rejected: the model picks the tool before the developer decides to add a note, so notes would appear on some cards and not others.
- Packing notes into `customInput`. Rejected: single-choice rejects `selectedOptions` with `customInput` (OMP `rpc-mode.ts:1155-1158`, Refract `requests.rs:355-359`), and on multi-select the model sees an unlabelled string.

**Consequences:**

- Refract loses OMP's ask timer that answers with the recommended option, and future OMP ask features unless they are ported. New asks have no "timed out" outcome; old transcripts still render it.
- The **Asked-user line** renders both native asks (history) and `refract_ask` results.
- Revisit this ADR if OMP ships #20156 or #20157 and the native wire then carries notes and per-option recommendations.
