# Away Mode answers, never cancels

Status: Accepted. Date: 2026-11-26. Decider: Stuart (#2031 and #2236 grill).

Away Mode (#433) answered a request that needed the developer by cancelling it: a `select`, `confirm` or `form` request got `{cancelled:true}`, and an approval waited five minutes before it was denied. A cancelled dialog makes the agent stop its turn, so an unattended Session stalled at the first question instead of working on (#2031). Subagent requests hit the same path, and a subagent that asked froze its parent (#2236).

**Decision:**

- Away Mode never cancels a request. A native `select` is answered with its first option. A `confirm` is answered No, the safe answer. After each answer Refract sends the agent one reason steer: "[Automatic, Away mode] Answered by Away Mode: the user is away. Proceed on your best judgement."
- An approval is denied at once. The five-minute wait is gone. The denial sends the same reason steer. Refract adds no dangerous-command detector; the Approval path remains the gate.
- Subagents get the same policy through the main agent, not through their own requests. The hidden Away instruction (`decorate_prompt` in `src-tauri/src/session/working_mode/mod.rs`, today sent only in Grill mode) tells the main agent that it is unattended and must not use the ask tool. It acts on its best recommendation, or consults a subagent or does research. It stops only for a genuinely dangerous or irreversible operation. It puts "you are unattended, do not ask" in every subagent brief. Reason steers go to the main agent. A live repro of #2236 on `origin/main` comes before the fix.
- A `form` request is submitted with its default values: the first option for each choice field, and the Away fallback text for an empty text field. The reason steer follows.
- Every automatic answer or denial is still recorded in the transcript and in the "While you were away" summary. No Away path stops the turn.

**Considered options:**

- Keep the five-minute approval wait. Rejected: an unattended Session idles for five minutes on every approval, and nobody is there to answer.
- Approve automatically unless the command is dangerous. Rejected: Refract has no dangerous-command detector, and building one would make Away Mode a second, weaker approval policy.
- Route a subagent's ask to the main agent. Rejected: the request frames carry no agent id, so Refract cannot tell whose request it is and cannot answer on the right agent's behalf.

**Consequences:**

- Away Mode may pick an option the developer would not have chosen. The first option of a `select` is not necessarily the safest, so the steer tells the agent to proceed on its own judgement rather than treat the pick as advice.
- Away Mode's "never picks an option for a dialog that may grant something" rule in spec 112 is replaced; `select` now takes the first option and the reason steer carries the caveat.
- Subagent behaviour depends on the model following the Away instruction. Refract does not enforce it; a subagent that asks anyway is a live-check finding, not a code path.
- [ADR 0012](0012-refract-owns-the-ask-tool.md) left Away Mode to #2031; `refract_ask` was already answered by Away Mode, and this ADR covers the native dialogs, approvals and forms.
