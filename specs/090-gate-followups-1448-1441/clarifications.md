# Clarifications

Decided (Skippy, delegated by Stuart 2026-10-31; UI rulings by ui-architect-v3):

1. Single-choice pick: advance, never auto-submit, show the hint "Choosing an option moves to the next question." when it advances (reverses #1435 auto-submit). Reason: a pick that submits cannot be corrected.
2. Cancel-discard confirm: skipped. Cancel is a quiet ghost button and the agent can re-ask.
3. Spelling menu: no group label; a disabled "No suggestions" row so Add to dictionary appears.
4. Warning wording: reuse the shake-menu link label with `ExternalLinkIcon`, keep `role="note"`.
5. Message Next in the last screen: ruled "fix"; deferred here for cost and risk, filed as a follow-up.
