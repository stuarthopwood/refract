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

Known gap: the pasted-image remove control (`AttachmentStrip.tsx:67-80`) has no tooltip today (the queued-message remove control, `QueuedChipList.tsx:76-96`, does); both remove controls are 24px (`size-6`) targets. The image control's tooltip is part of the #474 sweep issue.

## Library and style

- Use `lucide-react` for every UI, status, action, and tool icon, including #469 tool icons (agenda item 3). It is already the only icon import in `src/renderer`.
- Use `@tabler/icons-react` whenever `lucide-react` does not have the icon we need, never as a substitute for an icon lucide already offers. It is a dependency since #646 (wave 2 Session list, 2026-10-29), where the first use is the GitHub, GitLab and Bitbucket brand marks. Import each icon by name (for example `import { IconBrandGithub } from '@tabler/icons-react'`), never the whole namespace, so the bundler tree-shakes the rest. Per Stuart (2026-10-10) it is not limited to brand marks.
- Use the default stroke width everywhere; never override it per icon.
- Icons use `currentColor`, never a hard-coded fill.

## Size ladder

| Size | Tailwind class | Use |
| --- | --- | --- |
| 16px | `size-4` | Default: buttons, menu items, headers, metadata, chips, inline status and notices. |
| 24px | `size-6` | Large glyphs in empty states and avatars. |

Icon boxes are 8, 16, 24 or 32px (#1252); the old 12px and 14px steps moved to 16px.

## Colour and decoration

Colour is meaning, never decoration (agenda item 9). It appears only for state, severity, brand marks, syntax highlighting, diffs, **agent-to-agent message identity** (amended 2026-10-22, #838: the glyph and label of an agent-to-agent line use `--agent-message`; see [foundations-tokens-theming.md](foundations-tokens-theming.md) "Reserved hues"), and a **Project colour** the developer chooses themselves (amended 2026-10-15, #887: a colour the user picks for a Project counts as identity, so it is meaning; the app never assigns one on its own). Never use an app-chosen per-tab accent colour or emoji as a UI icon, including in the file explorer (#463) — file types there use `lucide` glyphs in the muted tone.

## Metadata iconography

Current rule, unchanged by the #474 grill: every piece of metadata shown in a tooltip, hover card, or compact info row — status, repository, branch, worktree path, model, files changed, and the like — gets a leading icon; bare text labels are not used for structured data of this kind. Actionable buttons inside a tooltip or card are right-aligned (trailing edge), never stacked at the left.

## Status, action, tool, and brand icons

- **Status icons**: the shared `StateIcon` component (`src/renderer/features/sessions/sessionDisplay.tsx`) draws every session display status — the agent-working spinner (`AgentSpinner`, issue #612) for working, a check in a circle for idle, a bell for needs-you, a square for stopped, a speech bubble with a tail for Unread response (issue #731, idle with an unseen reply, in the `--state-unread-response`/info colour) — each paired with an `sr-only` label, so colour is never the only signal.
- **Chat Status icons** (issue #570, distinct from the session-list `StateIcon` above): `toolStatus.tsx`'s `StatusIcon` (tool rows and groups) and `subagentStatus.tsx`'s `SubagentStatusGlyphIcons` (**Stage** groups, **Subagent chain**, **Subagent panel**, issue #563) both read one shared icon/colour table (`statusGlyph.ts`, gate round 1): a spinner in the working colour for running, a check-circle for done/finished, an error-coloured x-circle for failed, a neutral unplug for interrupted/exited, and a neutral stop-circle for a subagent's own cancelled (a cancel/abort is not a failure, issue #563 decision 15) **and (issue #911) a tool row's own cancelled -- the SAME stop-circle shape, a muted "Stopped" word -- settled only when the user's own Stop button cut a still-running call short, never from matching the call's own error text; a genuine failure still gets the error x-circle**. **Done is neutral on tool rows and groups** (a log of mostly green tool calls would hide the failures), **and green (the success token, icon and text) on finished agents and Stages** in the Subagent chain, Stage rows and the Subagent panel (amended 2026-10-15, Stuart, #941; previously neutral there too). **A completed Todo task is the same exception**: `TodoTree.tsx`'s shared `TASK_STATUS_GLYPH.completed` (the pinned panel and the Todo card both render through this one module) reads the success token, icon and text, keeping only the "Done" word `sr-only` and the check-circle shape as the non-colour cue (amended 2026-10-21, Stuart, #700/#701; previously neutral there too). Every icon is `aria-hidden`, paired with a visible or `sr-only` status word so colour is never the only signal.
- **Severity icons**: one set for every notice — info circle, success check, warning triangle, error octagon — each a distinct `lucide` shape plus the severity word; colour only reinforces it.
- **Action icons**: toolbar and row actions use plain `lucide` icons at the size ladder above. Action-menu items carry no icon (text only); destination and settings menus put a leading icon on every item (see Menus in components.md).
- **Tool icons** (#469): `lucide`, under the same library and size rules as every other icon — there is no separate icon family for tool calls.
- **Brand icons** (#646): the Project header in the Session list shows a Tabler brand mark (`IconBrandGithub`, `IconBrandGitlab`, `IconBrandBitbucket`) when its remote host is `github.com`, `gitlab.com` or `bitbucket.org`; any other remote keeps the lucide `FolderGit2Icon`, and no remote keeps `FolderGitIcon`. The mark takes the header's muted text colour, or the Project colour (#887). The tooltip reads `Git repository, remote: {host}/{owner}/{repo}`, with credentials stripped in Rust before the value crosses IPC. Resolved (2026-10-09, #533): the composer's Markdown hint icon is not a brand mark, so it uses lucide `TypeIcon`.

## Open

The boundary between a "decision button" and a "standalone command" at the edges is still open (#474); settle it case by case until the sweep issue records a rule.
