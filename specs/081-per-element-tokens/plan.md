# Plan: spec 081

## Design

- **Tokens.** One block in `globals.css`, selector `:root, .theme-dark, .theme-obsidian, .theme-dark-high-contrast, .theme-nordic-frost, .theme-cyber-amber`, declaring every FR-1 token as `var(--role)` (or a `color-mix` of a role for the pill). `@theme inline` gets one `--color-<token>` per token. The allowlist JSON gains the names.
- **Call sites.** Replace role classes with the new utilities in the components listed in FR-3. `NoticeRow`, `ToolIcon`, `ThoughtRunRow` and `ToolRow` keep their structure; only the class strings change. `Button` variants swap role classes for tokens (the `dark:` pairs collapse, since every theme is dark).
- **Scripts.** `scripts/theme-tokens.mjs` merges the `:root` declarations into each theme's raw properties before resolving, so the new defaults resolve per theme. `scripts/theme-contrast-pairs.mjs` gets one pair per fg/bg token. `src/renderer/lib/themeContrast.ts` gets about 10 representative pairs.
- **#1479.** Rust: `themes_remove` ordering and `MAX_FILE_BYTES` export in `theme_files.rs`. Renderer: `init-stores` stale settings guard, `confirmRemove` finally and error prop, import busy state without the duplicate toast, `RowKebabMenu` cleanups, rejected-file `role`, group labels, `aria-controls`, Profile menu label, Toaster-mounted bootstrap notice, forced-colors outline on `UserMessageRow`.
- **Docs.** `foundations-tokens-theming.md` token table, `docs/PLAN.md` rows.

## Analysis (consistency check)

- Defaults equal the roles the call sites use today, so no screenshot changes in the five built-ins.
- Tokens are colours only, so the Rust validator's grammar needs no change; it reads the allowlist with `include_str!`.
- `status-pill-attention-*` mixes use `transparent`, which the contrast script already parses.
- Constitution V is untouched: values still reach the DOM through `setProperty`.
- File-size and comment-density: the block in `globals.css` carries one short comment; CSS is outside the size cap.
