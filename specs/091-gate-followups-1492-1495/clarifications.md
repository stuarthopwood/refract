# Clarifications (spec 091)

Decided (Skippy, delegated by Stuart 2026-10-31):

1. Busy hover: gate once in the base Button (`not-aria-disabled:`), not per caller. Callers with their own hover classes keep them.
2. CompactList: wrap rather than truncate (no hover-only text); a `title` item is focusable. A truncation measurer was rejected as costly.
3. Roster open: canonicalise and require `<canonical root>/<known name>`, longest name first. A user-set `PI_CODING_AGENT_DIR` that is itself a symlink is refused (safe failure).
4. Theme store: roll back to the persisted (`confirmedCustomId`) custom theme; a stale custom reply clears itself when the latest pick was built-in.
5. Kebab disabled reason goes in the label, since an IconButton label and tooltip are one string.
6. IconButton derives `aria-keyshortcuts`; opt-out by passing `undefined`.
7. Skips as listed in `spec.md`.
