# Product first run and settings

Decided by Stuart in the #474 grill, 2026-10-08.

This page covers the readiness checklist, first-run empty states, the product-level behaviour of the Settings screen's first build, and the channels Refract uses to surface problems.

## First run and empty states

- With nothing configured, the window shows a readiness checklist: git found, OMP found and on the supported version, OMP signed in. Each failing item has a fix hint.
- Above the checklist sits a brand header with the hero icon, the bold **Refract** wordmark, and the tagline *One Pi, every angle.* in a lighter-weight Geist font (no longer italic); the checklist itself keeps only its own title, **Get Refract ready**, with no tagline inside it.
- One primary action, **Add repository**, is disabled until the checklist passes. After that, Sessions are created from the Repository header buttons in the session list; with no Session shown in a pane (including after closing the only open one, issue #621), the chat pane reads "Select a Session or create one."
- Once a repository exists, the first-run screen is gone, so the session list keeps a persistent **Add repository** button in a footer below the repository groups. It opens the same dialog and returns focus to the button on close.
- Each repository header has a **Repository actions** menu (a vertical-ellipsis button, shown on hover and on keyboard focus) with one item, **Remove repository…**. It opens a confirmation dialog. When the repository still owns Sessions, archived ones included, the dialog says how many are active and how many are archived, that they must be deleted first, and offers only **Close**. When it owns none, the dialog says only Refract's entry is removed and the folder on disk is untouched, with **Cancel** and **Remove**. Closing without removing returns focus to the menu button. After a removal the group disappears at once and focus moves to the next repository's header; removing the last repository returns to the first-run screen with focus on its **Add repository** button. A failure shows a notice and changes nothing.
- **Empty transcript** (Stuart, 2026-10-04, new): a Session whose transcript has no real exchange yet -- genuinely zero items, or only the agent's own unsolicited startup `notice`(s) (e.g. a mounted-MCP-tools banner) -- shows a neutral placeholder, "Ready. Type a message to get started.", instead of that raw notice text; the notice itself is never dropped from the transcript, so it (and anything else) renders normally the moment the Session has real content.
- UI text uses the product's own terms and never refers to requirements, tasks, stories, specs, or build state; `pnpm check:ui-text` partly enforces this on the built bundles (it fails only on the exact, case-sensitive patterns `FR-NNN`/`SC-NNN`/`TNNN`/`USN`, "later task," "wired up," and "User Story" -- "not implemented" is currently allow-listed, and wording like "spec" or "build state" itself is a review check, not a script check). See [patterns.md](patterns.md) (Microcopy vocabulary) for the full rule.

## Settings in the first build

- Approval mode (a pill above the message box, spec 001 T098; no longer on the status bar).
- Theme: shipped (spec 007) -- Appearance section, Dark / Dark (high contrast) presets, live preview. UI font, code font (family, ligatures, size): wanted, not yet built; tracked as issue #4.
- Background watermark: shipped (spec 012) -- Appearance section, a switch below the theme picker with a live preview; on by default, applies immediately with no restart.
- Chat width: shipped (issue #554) -- Appearance section, Full (default) / Reading column, Save/Cancel live preview, directly below the theme picker.

Note: the canvas-colour decision (#474 agenda item 9) adds a built-in **Obsidian** preset alongside Dark and Dark (high contrast); see [foundations-tokens-theming.md](foundations-tokens-theming.md).

## Feedback and errors

Decided in the #474 grill (agenda item 7): these channels are confirmed, no longer a default proposal; [patterns.md](patterns.md) documents the full channel and severity-icon rule (banner, toast, inline text, transcript notice) that these channels now sit inside.

- Problems belonging to one Session (agent stopped, worktree missing) show as a persistent banner in that Session's chat and a stopped state in the list.
- Transient app-level problems (a branch list failed to load) show as a toast.
- A Windows notification fires only for **needs you** and **finished**, and only when Refract is not the focused window; clicking it opens that Session.

## Open

- Whether the "UI text... never refers to requirements, tasks, stories, specs, or build state" rule above interacts with the #474 naming and microcopy rules (agenda item 6, see [patterns.md](patterns.md)) was flagged as open in the grill and not explicitly resolved.
