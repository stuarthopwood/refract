# spec 080: Gate follow-ups for specs 075, 076 and 008 (#1463, #1469, #1477)

Clears the Medium and Low findings left by the gates of PRs #1464, #1471 and #1478. Renderer plus Rust hardening; no IPC shape change unless an item says so.

## Clarifications

### Session 2026-10-31 (self-grill, Skippy delegated by Stuart; the issues are the grill)

- Q: Scope? [Decided] Every item that is a real fix is done. Items that are product calls, large migrations or overlap the design-sweep lane (#1466-#1468: menu icons, theme swatches, raw spacing, 40px panel header) are skipped with a reason recorded on the issue.
- Q: Fired alarm Dismiss/Re-arm? [Decided] A fired alarm row shows Dismiss and Re-arm actions in the popover; the bell badge keeps the fired highlight until dismissed, whether or not the popover was open when it fired.
- Q: Alarm form defaults? [Decided] Default time is now plus 5 minutes (not 1); the Save button shows a visible Saving cue; the label field has a visible "Label (optional)" label.
- Q: Kebab accessible name? [Decided] "More actions, <command or language>" per row, not a shared name.
- Q: Copy feedback rule? [Decided] Inline control = `CopyButton` (check icon + announcement); menu item = toast. Documented in `docs/design/components.md`. Right-click "Copy image" stays a toast.
- Q: InlineStatus error cue? [Decided] An icon plus sr-only "Error:" prefix; colour is never the only cue.
- Q: Button loading? [Decided] `Button` gains `loading` (spinner, `aria-busy`, disabled) and a single `aria-disabled` look; hand-built spinners migrate to it.
- Q: ExternalLink href? [Decided] https only; other schemes render as inert text.
- Q: Avatar hardening? [Decided] Request `s=96`, cap at 64 KB, validate the `data:image/` prefix on cache read, cap display name length.
- Q: Skipped (record on issues)? [Decided] See `tasks.md` "Skipped".

## Functional requirements

- FR-1: Every non-skipped item in #1463, #1469 and #1477 is implemented as listed on the issue.
- FR-2: Rust hardening items have `cargo test` coverage only where the issue already names a Rust test; no new renderer tests.
- FR-3: A chained live check (`scripts/verify-tauri-080.mjs`) exercises the changed paths against a scratch exe.
