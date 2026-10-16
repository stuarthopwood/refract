# Icons

This page covers icon policy by role, the icon-only requirement bundle, the icon library and size ladder, colour and decoration rules, and the status, action, tool, and brand icon sets.

Decided by Stuart in the #474 grill, 2026-10-08.

## Treatment by role

Three treatments, chosen by what the control does (agenda item 1):

| Role | Treatment | Examples |
| --- | --- | --- |
| Decision buttons in cards, dialogs, and banners | Label only | Approve, Deny, Recover, Delete, Cancel |
| Repeated row and toolbar actions | Icon only, with the bundle below | History, refresh, row menus |
| Standalone commands that create, open, or copy | Leading icon plus label | New conversation, Add repository, Open in file explorer, Copy path |

## Icon-only bundle

Give every icon-only control all of the following (agenda item 2):

- A Tooltip whose text equals its `aria-label` (verb first, sentence case).
- The `Kbd` shortcut inside the tooltip, when one exists.
- The tooltip (and any hover or focus popover) is dismissible with Esc without moving pointer or focus, hoverable (never `disableHoverableContent`), and persistent until hover or focus leaves or the user dismisses it (WCAG 1.4.13).
- The tooltip also shows on keyboard focus-visible, not only pointer hover.
- A 400ms open delay; instant when moving between neighbouring icon-only controls.
- A 24px minimum target.

Dialog and sheet Close controls follow the same bundle.

**Never make a destructive or ambiguous action icon-only.** Destructive means it loses work that cannot be recovered — Delete session, Delete repository data, Discard draft. These always carry a label or live in a menu.

**Reversible removals are the one exception**: Remove attachment and Remove queued message stay icon-only, with the full bundle above and no confirm step.

Known gap: neither control has its tooltip today (`AttachmentStrip.tsx:41-49`, `MessageInput.tsx:714-722`), and the attachment control's target is a 16px button (`size-4`) around a 10px icon, short of the 24px minimum; both become part of the #474 sweep issue.

## Library and style

- Use `lucide-react` for every UI, status, action, and tool icon, including #469 tool icons (agenda item 3). It is already the only icon import in `src/renderer`.
- Use `@tabler/icons-react` whenever `lucide-react` does not have the icon we need, never as a substitute for an icon lucide already offers -- still not a dependency in this repository. The first intended use is GitHub/GitLab/Bitbucket brand marks, tracked by **#646**. #528 shipped interim with `lucide`-only icons instead (`FolderGitIcon`/`FolderGit2Icon`, a binary remote-vs-local-only distinction, no per-host brand marks): Main, delegated by Stuart, asked for that simpler distinction with zero new dependencies rather than add this package mid-session (disk space on the shared build machine was tight). This is a deferral, not a reversal: the brand marks stay the first planned use, tracked as **#646**, a follow-up to #528. **2026-10-10 (Stuart): supersedes the brand-marks-only limit** -- `@tabler/icons-react` is no longer restricted to brand marks; adding the dependency happens in the PR that first needs it.
- Use the default stroke width everywhere; never override it per icon.
- Icons use `currentColor`, never a hard-coded fill.

## Size ladder

| Size | Tailwind class | Use |
| --- | --- | --- |
| 12px | `size-3` | Beside `text-xs` in metadata and chips, and `xs` buttons. |
| 14px | `size-3.5` | Inline status, notices, and `sm` buttons. |
| 16px | `size-4` | Default: buttons, menu items, and headers. |

## Colour and decoration

Colour is meaning, never decoration (agenda item 9). It appears only for state, severity, brand marks, syntax highlighting, diffs, and a **Project colour** the developer chooses themselves (amended 2026-10-15, #887: a colour the user picks for a Project counts as identity, so it is meaning; the app never assigns one on its own). Never use an app-chosen per-tab accent colour or emoji as a UI icon, including in the file explorer (#463) — file types there use `lucide` glyphs in the muted tone.

## Metadata iconography

Current rule, unchanged by the #474 grill: every piece of metadata shown in a tooltip, hover card, or compact info row — status, repository, branch, worktree path, model, files changed, and the like — gets a leading icon; bare text labels are not used for structured data of this kind. Actionable buttons inside a tooltip or card are right-aligned (trailing edge), never stacked at the left.

## Status, action, tool, and brand icons

- **Status icons**: the shared `StateIcon` component (`src/renderer/features/sessions/sessionDisplay.tsx`) draws every session display status — the agent-working spinner (`AgentSpinner`, issue #612) for working, a check in a circle for idle, a bell for needs-you, a square for stopped, a speech bubble with a tail for Unread response (issue #731, idle with an unseen reply, in the `--state-unread-response`/info colour) — each paired with an `sr-only` label, so colour is never the only signal.
- **Chat Status icons** (issue #570, distinct from the session-list `StateIcon` above): the shared tool/subagent map -- `toolStatus.tsx`'s `StatusIcon` (tool rows and groups) and `subagentStatus.tsx`'s `SubagentStatusGlyphIcons` (**Stage** groups, **Subagent chain**, **Subagent panel**, issue #563) -- render the identical icon shape and colour per matching state: a spinner in the working colour for running, a neutral check-circle for done/finished (never chromatic: a success colour used outside its own meaning teaches the wrong meaning), an error-coloured x-circle for failed, and a neutral unplug for interrupted/exited/cancelled. Every icon is `aria-hidden`, paired with a visible or `sr-only` status word so colour is never the only signal.
- **Severity icons**: one set for every notice — info circle, success check, warning triangle, error octagon — each a distinct `lucide` shape plus the severity word; colour only reinforces it.
- **Action icons**: toolbar and row actions use plain `lucide` icons at the size ladder above. Action-menu items carry no icon (text only); destination and settings menus put a leading icon on every item (see Menus in components.md).
- **Tool icons** (#469): `lucide`, under the same library and size rules as every other icon — there is no separate icon family for tool calls.
- **Brand icons**: none shipped yet. `@tabler/icons-react` is the decided source for a future GitHub/GitLab/Bitbucket brand mark (see Library and style above) and remains the first intended use; #528 shipped with `lucide`-only icons instead, deferred to **#646**. **Resolved** (2026-10-09, #533 issue update comment): the composer's Markdown hint icon is NOT a brand mark, so it uses lucide `TypeIcon`, not Tabler's `IconMarkdown` (this predates and is unaffected by the 2026-10-10 rule change, since lucide already has the icon needed).

## Open

The boundary between a "decision button" and a "standalone command" at the edges is still open (#474); settle it case by case until the sweep issue records a rule.
