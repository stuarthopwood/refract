# Product first run and settings

Decided by Stuart in the #474 grill, 2026-10-08.

This page covers the readiness checklist, first-run empty states, the product-level behaviour of the Settings screen's first build, and the channels Refract uses to surface problems.

## First run and empty states

- A successful launch shows no checklist. When git, OMP (found and on the supported version) or OMP sign-in fails, the window shows a three-step stepper (git found, OMP found and supported, OMP signed in) with the failed step expanded and its fix hint in the body.
- Above the stepper sits a brand header with the hero icon, the bold **Refract** wordmark, and the tagline *One Pi, every angle.* (no longer italic); the header wraps and scales down below the `sm` breakpoint so it never forces horizontal scroll at 320 px.
- One primary action, **Add project** (a menu: Local folder... or Clone from GitHub...), is disabled until the checklist passes. After that, Sessions are created from the Project header buttons in the session list; with no Session shown in a pane (including after closing the only open one, issue #621), the chat pane reads "Select a Session or create one."
- Once a project exists, the first-run screen is gone, so the session list keeps a persistent **Add project** menu button in a footer below the project groups. Its items are **Local folder...** (the paste-or-browse dialog) and **Clone from GitHub...**; focus returns to the button on close.
- **Settings > Projects** holds one group, **Cloning**, with **Default clone folder**: the folder the Clone from GitHub dialog prefills. It shows the path (or "Not set"), **Browse**, and **Clear**, and saves immediately.
- Each project header has a **Project actions** menu (a vertical-ellipsis button, shown on hover and on keyboard focus) with one item, **Remove project…**. It opens a confirmation dialog. When the project still owns Sessions, archived ones included, the dialog says how many are active and how many are archived, that they must be deleted first, and offers only **Close**. When it owns none, the dialog says only Refract's entry is removed and the folder on disk is untouched, with **Cancel** and **Remove**. Closing without removing returns focus to the menu button. After a removal the group disappears at once and focus moves to the next project's header; removing the last project returns to the first-run screen with focus on its **Add project** button. A failure shows a notice and changes nothing.
- **Empty transcript** (Stuart, 2026-10-04, new): a Session whose transcript has no real exchange yet -- genuinely zero items, or only the agent's own unsolicited startup `notice`(s) (e.g. a mounted-MCP-tools banner) -- shows a neutral placeholder, "Ready. Type a message to get started.", instead of that raw notice text; the notice itself is never dropped from the transcript, so it (and anything else) renders normally the moment the Session has real content.
- UI text uses the product's own terms and never refers to requirements, tasks, stories, specs, or build state; `pnpm check:ui-text` partly enforces this on the built bundles (it fails only on the exact, case-sensitive patterns `FR-NNN`/`SC-NNN`/`TNNN`/`USN`, "later task," "wired up," and "User Story" -- "not implemented" is currently allow-listed, and wording like "spec" or "build state" itself is a review check, not a script check). See [patterns.md](patterns.md) (Microcopy vocabulary) for the full rule.

## Settings in the first build

- Approval mode (a pill above the message box, spec 001 T098; no longer on the status bar).
- Theme: shipped (spec 007) -- Appearance section, Dark / Dark (high contrast) presets, live preview. UI font, code font (family, ligatures, size): wanted, not yet built; tracked as issue #4.
- Background watermark: shipped (spec 012) -- Appearance section, a switch below Chat width (issue #554 inserted Chat width between the theme picker and this switch) with a live preview; on by default, applies immediately with no restart.
- Chat width: shipped (issue #554) -- Appearance section, Full (default) / Reading column, autosaved on choose (spec 068), directly below the theme picker.
- OMP settings: Refract is the source of truth for every OMP setting it exposes (see [Principles](index.md#principles)). Settings writes the value to OMP's global config, overwrites any existing value after a backup, and shows the effective value. Tracked in #691 and #1767.

Note: the canvas-colour decision (#474 agenda item 9) adds a built-in **Obsidian** preset alongside Dark and Dark (high contrast); see [foundations-tokens-theming.md](foundations-tokens-theming.md).

## Feedback and errors

Decided in the #474 grill (agenda item 7): these channels are confirmed, no longer a default proposal; [patterns.md](patterns.md) documents the full channel and severity-icon rule (banner, toast, inline text, transcript notice) that these channels now sit inside.

- Problems belonging to one Session (agent stopped, worktree missing) show as a persistent banner in that Session's chat and a stopped state in the list.
- Transient app-level problems (a branch list failed to load) show as a toast.
- A Windows notification fires only for **needs you** and **finished**, and only when Refract is not the focused window; clicking it opens that Session.

## Open

- Whether the "UI text... never refers to requirements, tasks, stories, specs, or build state" rule above interacts with the #474 naming and microcopy rules (agenda item 6, see [patterns.md](patterns.md)) was flagged as open in the grill and not explicitly resolved.
