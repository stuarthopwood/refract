# Quickstart: verifying font weights and action verbs

Use a scratch debug build (never `pnpm dev`), the shared `CARGO_TARGET_DIR`, and a scratch data dir (`REFRACT_DATA_DIR`); see `scripts/verify-tauri.mjs`. Build with `pnpm exec tauri build --debug --no-bundle`, copy `<CARGO_TARGET_DIR>/debug/refract-tauri.exe` to a scratch folder, and run the copy with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`. Drive a recorded-frame `session` fixture so transcript rows appear with no model cost.

Repeat steps 1 to 8 on each of the five themes (Dark, Dark (high contrast), Obsidian, Nordic Frost, Cyber Amber), at the default window width and at 360 px. Save a screenshot of each transcript and of Settings per theme.

1. Transcript rows: tool, thought, stage, agent-message and advisory labels compute to `font-weight: 400` (`[data-slot="collapsed-line-label"]`). Labels use the body colour and summaries stay muted. Error rows may be heavier.
2. Verbs: a running `read` row reads "Reading", and the done row reads "Read". Check Edit/Edited, Writing/Wrote, and Thinking/Thought process the same way. A grouped row reads "Read ×2". An unknown tool such as `mcp_fetch-page` reads "Mcp fetch page".
3. Colons: "Skill invoked" and "Asked user" have no trailing colon.
4. Accessible names: a running read row's name starts with "Reading", with no "Running" before it. A failed row starts with "Failed". The live region announces "Reading" when a read starts.
5. Row start: the icon and label still mark where each row starts, including at 360 px.
6. Weight changes: the active Pull requests tab is 500 and the tab row does not reflow when you switch tabs. The selected role option is 500 with no visible shift. The chat header badge is 500 and not uppercase.
7. Scale: Settings page headings compute to 600, in-chat Markdown headings to 500, the brand text on Readiness to 700, and ghost buttons to 400.
8. Contrast: run `pnpm check:theme-contrast`; muted text on `bg-muted` surfaces passes on every theme, as it did before.
