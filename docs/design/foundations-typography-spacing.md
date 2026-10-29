# Typography and spacing

This page covers the App, Chat, and Code font roles, label case and monospace rules, the spacing grid, control heights, transcript rhythm, the shared panel header height, and the reading-width setting.

Decided by Stuart in the #474 grill, 2026-10-08.

## Font roles

Refract exposes three independent font roles, each with its own picker (#4).

| Role | Covers |
| --- | --- |
| `App` | Chrome: session list, headers, menus, dialogs, Settings. |
| `Chat` | Message prose in the transcript. The composer's text area uses the `App` font (Geist) at `--text-readout` since #839 (2026-10-29); it keeps the `Code` text scale. |
| `Code` | Code blocks, inline code, tool output, diffs, and diff/PR file headers. |

Use a bundled OFL font or an installed system font for any role; bundling was decided 2026-10-07 (#4) and supersedes the old `docs/DESIGN.md` Fonts rule (now in [product-look-and-feel.md](product-look-and-feel.md)) that Refract "uses fonts installed on the system and does not bundle any". Each picker lists a **Bundled** group (always available, identical on every machine) above an **Installed** group (searchable system fonts); a missing installed font falls back to the default stack silently, with a note in Settings.

The starter bundle (Latin subset, WOFF2, about 223 KB total) is Geist (the default), Inter, Atkinson Hyperlegible, and IBM Plex Sans for `App`/`Chat`, and JetBrains Mono, Fira Code, and Geist Mono for `Code`. None of the candidate `Code` fonts carry Nerd Font glyphs (checked: zero Private Use Area code points in their glyph tables); Nerd Font glyphs still need an installed Nerd Font.

## Case and label style

- Use sentence case for every label, heading, and group title. Never use an uppercase or letter-spaced ("tracked") label, even for a dense metadata header — this rejects the #549 mockup's `ORCHESTRATION DAG` style (agenda item 10).
- Set section and group labels in the `App` font, small, regular weight, and the muted text colour, consistent with the sentence-case rule above.

### Action labels

Tool and thought rows show an action label: a sentence-case verb from the shared map in `src/renderer/features/chat/toolVerbs.ts`. Use the running form while the action is in progress and the done form once it finishes.

| Tool | Running | Done |
| --- | --- | --- |
| `read` | Reading | Read |
| `edit` | Editing | Edited |
| `write` | Writing | Wrote |
| `bash` | Running | Ran |
| `grep`, `find` | Searching | Searched |
| `thinking` | Thinking | Thought process |
| `skill` | Using skill | Used skill |

- A tool that the map does not know shows its own name in sentence case: underscores and hyphens become spaces, repeated spaces collapse, and only the first letter is capitalised. For example, `web_search` reads "Web search". An empty name reads "Tool".
- Do not end a label with a colon. Write "Asked user", not "Asked user:". An inline name-value prefix that is followed by its value on the same line, such as "Answer:", keeps its colon.
- Action labels use regular weight (400). Hierarchy comes from colour, not weight.

## Font weight scale

Use one weight scale on every theme. Do not add theme-specific weight tokens, and do not use a separate weight for dark themes. The scale applies to all built-in themes and to any theme added later.

| Weight | Use |
| --- | --- |
| 300 (light, `font-normal`) | White (`text-foreground`) body text, labels, and metadata |
| 400 (regular, `font-medium`) | Buttons, selected states; non-white (muted, severity, accent) text at normal weight |
| 500 (medium, `font-semibold`) | Page titles, such as Settings section headings, `<b>`/`<strong>` body text, and `font-medium` on non-white text |
| 600 (semibold, `font-bold`) | Markdown headings, the Refract wordmark, and `font-semibold` on non-white text |

Do not use 450, or any other weight outside this table. The scale is one step lighter than the Tailwind defaults: `@theme` in `globals.css` remaps `--font-weight-normal/medium/semibold/bold` to 300/400/500/600 (issue #1246), so write the usual utility, never a literal number. The default `App`/`Chat` font is Geist and the default `Code` font is Geist Mono, both variable (wght 100-900). Code ligatures follow the Settings > Chat "Code ligatures" switch.

Non-white text is one step heavier at every size (issue #1267, amended 2026-10-28). The colour utilities `text-muted-foreground`, `text-accent-text`, `text-destructive` and `text-severity-*` remap `--font-weight-normal/medium/semibold` to 400/500/600 on the element (`@layer base` in `globals.css`), so an unclassed muted element is 400 and an explicit `font-medium` on it is 500, with no per-component edit. `font-bold` stays 600, the top of the scale. Markdown headings use `font-bold` (600) so they stay heavier than bold body text (500). Children inherit the remap; wrap white text inside a muted parent in its own element if it must stay 300.

The scale caps weights. It does not raise them: a heading or label that is lighter than its role's weight keeps its current weight.

## Monospace use

Reserve the `Code` font for code-shaped data only: code, paths, commands, branch names, IDs, hashes, and token and file counts that must align in a column. Never use it for general metadata or labels — those stay in the `App`/`Chat` font at normal case (agenda item 10).

## Session list type ladder

Decided by the ui-architect-v3 roundtable, 2026-10-15 (issue #567, the type-scale open question): no 10px or 11px text anywhere in the session list, only Tailwind's own `text-sm`/`text-xs` steps.

| Element | Classes |
| --- | --- |
| Row title | `text-sm font-normal text-sidebar-foreground` -- weight never changes when the row is selected, so the text never reflows. |
| Row second line (Activity line) | `text-xs text-muted-foreground` |
| Row time | `text-xs tabular-nums text-muted-foreground` |
| Group header label | `text-xs font-normal text-muted-foreground` |

Hand-measured reason for dropping the mock's own grey: muted text on a selected/hovered row's fill measures 5.8:1 (Dark), 5.1:1 (Obsidian) and 9.8:1 (Dark, high contrast) using `--muted-foreground`; the mock's own `#737373` measures 3.2:1 to 3.8:1 on the same fills, under the 4.5:1 text floor.

## Status line type

Decided 2026-10-16 (issue #928, v0.3.0 feedback item 5): the composer status line's chips (changes, context, elapsed, todo, subagents, pull request, current time) read 13px text and 14px icons, up from the original 12px/12px -- Stuart chose this over a 14px TEXT step, which would read "as loud as the chat". No existing Tailwind step is 13px (`text-xs` is 12px, `text-sm` is 14px), so this adds the one named step, `--text-readout` (globals.css), generating the `text-readout` utility rather than a bare `text-[13px]` arbitrary value.

| Element | Classes |
| --- | --- |
| Status line chip text (`ReadoutChip.tsx`) | `text-readout text-muted-foreground` (13px) |
| Status line chip icon (`ReadoutChip.tsx`) | `size-4` (16px; was 14px before #1252) |

Scoped to `ReadoutChip.tsx` alone, the status line's own shared baseline component -- nothing else reads `text-readout` today.


## Spacing grid

Use an 8px grid with a 4px half-step for padding, margin, and gap (decided 2026-10-27, #1252; it supersedes the 4px grid of #474). Use the 4px step only for tight icon-to-text gaps and inline chip padding. Never use an off-scale value (`p-1.5`, `gap-3`, `px-2.5`, `py-0.5`) or an arbitrary pixel value in a component; `pnpm check:spacing` (part of `pnpm ci:local`) fails on them, and `scripts/spacing-allowlist.json` lists any justified exception. Control and icon sizes follow the ladders below.

| Step | Tailwind class |
| --- | --- |
| 4px (half-step) | `1` |
| 8px | `2` |
| 16px | `4` |
| 24px | `6` |
| 32px | `8` |
| 40px | `10` |
| 48px | `12` |

Larger offsets (for example space reserved for a trailing button) are multiples of 8px.

## Control heights

Control heights are 24 and 32px (`xs`/`sm` and `icon-xs`/`icon-sm` at 24px, `default`/`icon` at 32px); `sm` and `icon-sm` dropped from 28px under #1252.

| Height | Button size | Icon-only size |
| --- | --- | --- |
| 24px | `xs`, `sm` | `icon-xs`, `icon-sm` |
| 32px | `default` | `icon` |

`button.tsx` also defines `lg` and `icon-lg` (36px); these are not part of the system, the same rule agenda item 4 applies to the unused `secondary` and `link` variants.

## Transcript rhythm

Keep the rhythm as built (`Transcript.tsx`): `mt-6` (24px) between turns and real user/assistant messages, and `mt-1` (4px) inside a run of consecutive bookkeeping rows (tool calls, thinking, notices). This settles #360.

## Panel header height

Use one fixed-height header row for every panel and pane (chat, Agents, Pull requests, FDB panes, side chat): title left, ghost icon-only actions right. **No bottom divider line** (Stuart, 2026-10-09): the header is separated from its content by a different surface shade and/or whitespace, not a border -- see "Panel header" in [components.md](components.md#panel-header).

The agenda item 8 decision proposed 40px, pending a measurement against today's chat header. Measured: `ChatHeader.tsx`'s `<header>` carries `flex h-10 shrink-0 items-center ... px-4`, with no bottom border -- #606 removed it outright, which is the accepted rule above, not a gap. Tailwind's `h-10` sets `height: 2.5rem` (40px at the project's default 16px root font size). Measured height: **40px**, confirming the proposed value — adopt 40px as the one panel header height everywhere.

## Reading width

Reading width is a Setting, defaulting to full width (#554, decided and shipped 2026-10-18). Full keeps the transcript unconstrained, filling the pane; the alternative, Reading column, caps the transcript at 64rem (`Transcript.tsx`'s `MessageScrollerContent`), centred, with a padding ladder (`px-6`/`@min-[40rem]:px-10`/`@min-[48rem]:px-14`/`@min-[64rem]:px-16`) keyed off the chat pane's own width via a container query, not the window -- see `docs/design/product-chat.md`'s own **Chat width** bullet for the full picture (Settings location, keyboard operation, live preview, persistence).

## Text size

Settings > Appearance > Text size sets three scales (80 to 150 percent): App (--scale-app, on :root), Chat (--scale-chat, inside `[data-text-role='chat']`, the transcript) and Code (--scale-code, inside `pre`, `code`, `kbd`, `samp` and `.font-code`, which covers diffs and file headers; the composer field carries `data-text-role='code'` so it follows this scale too). Each container redeclares the `--text-*` size tokens as `max(min(base, 11px), base * scale)`, so no size renders below 11px unless its base is already smaller and sizes are unchanged at 100 percent. Fixed-height controls use `min-h-*` so they grow rather than clip. Use the size tokens (`text-compact`, `text-micro`, `text-badge`); never an arbitrary `text-[...]`. OS text scaling is not read.

