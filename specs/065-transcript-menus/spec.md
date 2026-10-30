# Spec 065: Transcript menus and copy/wrap controls (#471, transcript group)

## Summary

Right-click and keyboard menus plus ghost controls on transcript surfaces: messages, code blocks, tool rows and Mermaid diagrams. Built on the action registry and menu-item builders (spec 064). The list group, Git changes and composer chips are separate PRs.

## User stories

1. As a reader, I copy a message as Markdown or plain text from a menu or a ghost button.
2. As a reader, I jump from an agent reply to the prompt that triggered it.
3. As a reader, I copy a code block and toggle line wrapping per block.
4. As a reader, I copy a Mermaid diagram's source, copy it as an image, or save it as a PNG.
5. As a keyboard user, I open each menu with Shift+F10 or the Menu key and Esc returns focus.

## Functional requirements

- FR-1 Message menu (user and agent): Copy (Markdown source), Copy as plain text. Agent replies add Scroll to your message via `jumpToMessage`.
- FR-2 A ghost Copy button sits in a reserved-height row under each finished message, aligned to the bubble edge, a Tab stop, revealed on hover or focus-within and while its menu is open.
- FR-3 Code block menu: Copy code, Wrap lines (checkbox), Expand/Collapse only where the block collapses. A visible ghost Wrap toggle (aria-pressed, not persisted) sits beside Copy, including when `hideCopy` is set.
- FR-4 Tool row menu: Copy command, Copy output (finished and output present), Expand/Collapse (label follows state). No menu while the tool runs.
- FR-5 Mermaid menu: Copy source, Copy as image (PNG, 2x, theme background), Save image... (native save dialog). A muted, always-visible button row sits below the diagram beside Show source.
- FR-6 No menu or Copy button on a message, code block, tool row or diagram while it streams.
- FR-7 On transcript surfaces Refract's menu replaces the native menu; Copy selection is first (with a separator) when text is selected. The composer keeps its spec 062 menu.
- FR-8 Every menu item has an icon; only one menu is open at a time (exclusive-menu store).
- FR-9 Items are declared in the action registry through the menu-item builders; shared components only (ADR 0003).
- FR-10 Feedback: Copy as image reports through the CopyButton announcement; Save image shows a toast with the saved path; failures use `notify()`.

## Clarifications

Grill (Stuart, 2026-10-30) decisions 1-10 on #471 are binding. UI ruling (ui-architect-v3, delegated): ghost Copy is a Tab stop; the Wrap control is a shared subtle icon Toggle; the Mermaid row sits below the diagram, not as an overlay; the tool menu hides while running; wrap items use a checkbox item; item order is Copy selection, copy items, then view or navigation items.

## Out of scope

List group, Git changes, composer chips, persisted wrap state, new tests (prototyping phase).
