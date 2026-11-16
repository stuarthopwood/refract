# Contract 129: Session Host tools

Errors use spec 124's `{ error: { code, message } }` with `isError: true`. Results are capped at 8 KiB. No tool raises the approval card.

## refract_list_sessions

Args: `{ project?: string, include_archived?: boolean }`.
Result: `{ sessions: Row[], total: number, truncated?: true }` with
`Row = { id, name, project: { id, name }, branch, status, archived, lastActivityAt, self?: true, hidden?: true }`. No PR.
Errors: `unknown_project`, `invalid_input`.

## refract_get_session_status

Args: `{ id: string }`.
Result: `{ id, name, project: { id, name }, status, stopReason?, archived, hidden, branch, pullRequest: { number, url } | null, lastActivityAt }`.
`status`: `working | waiting-for-approval | idle | paused | stopped`. `stopReason` (only with `stopped`): `not-started | agent-exited | start-failed | worktree-missing | stopped-on-request`.
Errors: `not_found`, `invalid_input`.

## refract_send_session_message

Args: `{ id: string, text: string }`. Sender is the stream owner, never an argument.
Result: `{ outcome: "sent" | "queued" | "held" }`.
Errors, in check order: `invalid_input` (empty or > 32 KB), `not_found`, `invalid_target` (own id), `session_not_running` (message includes target status), `rate_limited`.

## Envelope

`<session-message from="NAME" session="ID">\nBODY\n</session-message>`. NAME escapes `& " < >`. In BODY, `&lt;session-message` and `&lt;/session-message` prefixes are produced by first escaping `&lt;` immediately before those tags, then the tags; parse reverses in the opposite order. Parser accepts exactly one envelope spanning the whole user text.

## Transcript

`TranscriptItem::User.source?: { kind: "session", sessionId, name }`, absent for ordinary turns.
