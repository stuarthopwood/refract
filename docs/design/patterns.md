# Patterns

This page covers cross-cutting behaviour patterns: microcopy vocabulary, destructive actions, loading, feedback channels, status, empty-state shape, placeholders and "coming soon," and keyboard and focus. Decided by Stuart in the #474 grill, 2026-10-08.

## Microcopy vocabulary

Naming and microcopy (agenda item 6) is sentence case, verb first, with no trailing period. Tooltips are the bare verb ("Search"), not a sentence.

| Term | Means |
|---|---|
| **Add** | Bring an existing, outside thing in (Add project, Add GitHub account). |
| **New** | Start a fresh thing Refract owns (New conversation, New session). |
| **Create** | Only on the confirm button of a form that makes something new. |
| **Cancel** | Abandon a pending choice or form. |
| **Close** | Dismiss a read-only view with nothing pending. |
| **Dismiss** | Hide a notice that may come back. |
| **Remove** | Take it out of Refract without deleting data (for example, a project). |
| **Delete** | Permanent. |
| **Archive** | Reversible; moves the Session to the Archived group and stops the agent. |
| **Hide** | Removes a Session from the session list only; nothing stops (#748). Reversible with Unhide or the toast's Undo. |
| **Retry** | Run a refused action again, in the same dialog (issue #891 gate round 1, ui-architect-v3: the confirm button relabels to Retry after a refusal rather than adding a second control). |

Confirm buttons repeat the verb ("Delete session"), never "OK" or "Yes." Evidence at `origin/main` 9f23d22: Add project (`AddRepositoryDialog`), Cancel (`PullRequestDetail`'s `AlertDialogCancel`), Close (the read-only/blocked dialog footer).

This vocabulary sits alongside the existing **"no project terms"** rule: UI text never refers to requirements, tasks, stories, specs, or build state, partly enforced on built bundles by `pnpm check:ui-text` (`scripts/check-ui-text.mjs`), which fails on the exact, case-sensitive patterns `FR-NNN`/`SC-NNN`/`TNNN`/`USN`, "later task," "wired up," and "User Story"; "not implemented" is currently allow-listed everywhere (a Mermaid bundle string contains it), so that phrase is never caught. Anything else (for example "spec 007" or "build state" itself) is a review check, not a script check.

The UPPERCASE tracked micro-labels shown in the AI Studio mock (for example "ORCHESTRATION DAG," "LIVE LOG STREAM") are not adopted: section and group labels are sentence case, closing the micro-label question left open in the naming discussion. See [foundations-typography-spacing.md](foundations-typography-spacing.md) (Case and label style).

## Destructive actions

Agenda item 2 and its follow-up (reversible removals) define "destructive":

- **Destructive** means losing work that cannot be recovered (Delete session, Delete project data, Discard draft). A destructive action is never icon-only: it always carries a label, or lives inside a menu or a dialog (see [components.md](components.md)).
- A **reversible removal** (Remove attachment, Remove queued message) may stay icon-only, but only with the full icon-only bundle: a `Tooltip` whose text equals the `aria-label`, the `aria-label` itself, and a 24px minimum target. No confirmation step.
- Reversible removals never get a confirm dialog.

Verified in code: `AttachmentStrip.tsx:41-49` ("Remove pasted image") and `MessageInput.tsx:714-722` ("Remove queued message") already have the `aria-label` but are missing the required `Tooltip` — an open audit finding, tracked by the #474 follow-up sweep issue, not fixed by this documentation change.

## Banners

The five rules for a Session- or pane-scoped problem row (#746; the component is in [components.md](components.md), "Banners"):

1. A banner is unboxed: no border, no fill.
2. Red is for the severity icon and for a destructive action's label only; the title stays foreground.
3. Actions: one `outline` primary, every other action a `text` button.
4. A destructive action is red text, last in the row, and always confirms in a dialog.
5. Message and detail are two lines: a short title, then the path or reason in the Code font.

## Loading

A loading state is a lucide spinner (`Loader2Icon`) plus words (for example, "Checking GitHub sign-in…"). The animating agent-working spinner (`AgentSpinner`, issue #612, supersedes the brand mark spinner `BrandSpinner`/spec 011) is reserved for exactly one meaning: an agent is working. Do not reuse it for any other kind of loading.

## Feedback channels

Five written-down channels (agenda item 7; `status` added by #865, 2026-10-29), each with one job:

| Channel | Scope | Dismissal |
|---|---|---|
| Banner | A problem scoped to one Session or pane | Stays until the problem is fixed. |
| Status | Work still running for one Session, such as background agents (`StatusBanner`, `src/renderer/components/StatusBanner.tsx`, mounted above the composer) | Non-modal and never dismissed by hand: each line leaves when its work settles. Icon plus word, never colour alone; zero-box; `aria-live="off"`, with one polite announcement per settle. No counters of pool limits. |
| Status (Retrying) | OMP is auto-retrying a failed model call (`RetryLine`, `src/renderer/features/chat/RetryLine.tsx`) | Same `StatusBanner`, with an amber "Retrying" status (warning triangle plus word, `text-severity-warning`), "Attempt N of M" text and a `text` Stop button (`aria-label` "Stop retrying"). Announces politely at retry start and once when it ends; focus inside the line moves to the composer when it ends. |
| Toast | A transient, app-level result | Auto-dismisses after about 5s, paused on hover and focus. **Errors never auto-dismiss.** Exception: a slash-command refusal warning stays until its own close button is used, a successful send from the same Session, or a newer refusal replaces it (#997). |
| Inline text | Form fields | Clears with the field's own validation. |
| Transcript notice | Agent-originated news | Renders as a normal transcript row; never dropped. |

## Status

Session display statuses keep five icons, never colour alone: the animating brand mark for working, a check in a circle for idle, a bell for needs-you, a square for stopped, and a speech bubble with a tail for Unread response (issue #731, idle with an unseen reply, drawn in place of the idle icon) (`StateIcon`, `src/renderer/features/sessions/sessionDisplay.tsx`).

Notices and toasts share one severity set, also never colour alone: info circle, success check, warning triangle, error octagon, each paired with the severity word. Colour only reinforces the icon and the word. See "Toasts and notices" in [components.md](components.md).

## Empty-state shape

An empty state is exactly three things: an icon, one line saying what is empty, and the next action. Nothing else.

## Placeholders and "coming soon"

Settled under agenda item 7's follow-up (#393): unbuilt features are never shown as "Coming soon" or as a disabled control with a visible reason. They are hidden entirely.

The exception is the FDB Knowledge and Agent Builder placeholder panes (#393), which may show **labelled sample data** behind a switch:

- A Settings switch, **"Show sample data,"** off by default.
- When on, every sample element carries a visible **"Sample data"** badge.
- Sample data is never mixed with real data.
- The switch and its sample content are removed outright once the real integration (#391, #392) lands.
- With the switch off, the panes show the honest empty state defined above (icon, one line, next action).

Note: Stuart's first answer to this question was "strict, honest empty state only, no sample data." On a re-ask in the same session he picked the Settings-switch option above instead; this page records that second, final answer as the decision, and the earlier "strict empty only" answer does not apply to #393.

This settles the #393 demo-content call (`docs/PLAN.md` row C1 and Decisions, 2026-10-08).

## Keyboard and focus

See the Keyboard table in [index.md](index.md#keyboard) for the shortcut list, and the focus-visible ring and focus-return rules in [foundations-motion.md](foundations-motion.md) (Focus), agenda item 11, #566.
