# Typography and spacing

This page covers the App, Chat, and Code font roles, label case and monospace rules, the spacing grid, control heights, transcript rhythm, the shared panel header height, and the reading-width setting.

Decided by Stuart in the #474 grill, 2026-10-08.

## Font roles

Refract exposes three independent font roles, each with its own picker (#4).

| Role | Covers |
| --- | --- |
| `App` | Chrome: session list, headers, menus, dialogs, Settings. |
| `Chat` | Message prose in the transcript and the composer's text area. |
| `Code` | Code blocks, inline code, tool output, diffs, and diff/PR file headers. |

Use a bundled OFL font or an installed system font for any role; bundling was decided 2026-10-07 (#4) and supersedes the old `docs/DESIGN.md` Fonts rule (now in [product-look-and-feel.md](product-look-and-feel.md)) that Refract "uses fonts installed on the system and does not bundle any". Each picker lists a **Bundled** group (always available, identical on every machine) above an **Installed** group (searchable system fonts); a missing installed font falls back to the default stack silently, with a note in Settings.

The starter bundle (Latin subset, WOFF2, about 223 KB total) is Inter, Atkinson Hyperlegible, and IBM Plex Sans for `App`/`Chat`, and JetBrains Mono, Fira Code, and Geist Mono for `Code`. None of the candidate `Code` fonts carry Nerd Font glyphs (checked: zero Private Use Area code points in their glyph tables); Nerd Font glyphs still need an installed Nerd Font.

## Case and label style

- Use sentence case for every label, heading, and group title. Never use an uppercase or letter-spaced ("tracked") label, even for a dense metadata header — this rejects the #549 mockup's `ORCHESTRATION DAG` style (agenda item 10).
- Set section and group labels in the `App` font, small, medium weight, and the muted text colour, consistent with the sentence-case rule above.

## Monospace use

Reserve the `Code` font for code-shaped data only: code, paths, commands, branch names, IDs, hashes, and token and file counts that must align in a column. Never use it for general metadata or labels — those stay in the `App`/`Chat` font at normal case (agenda item 10).

## Session list type ladder

Decided by the ui-architect-v3 roundtable, 2026-10-15 (issue #567, the type-scale open question): no 10px or 11px text anywhere in the session list, only Tailwind's own `text-sm`/`text-xs` steps.

| Element | Classes |
| --- | --- |
| Row title | `text-sm font-normal text-sidebar-foreground` -- weight never changes when the row is selected, so the text never reflows. |
| Row second line (Activity line) | `text-xs text-muted-foreground` |
| Row time | `text-xs tabular-nums text-muted-foreground` |
| Group header label | `text-xs font-medium text-muted-foreground` |

Hand-measured reason for dropping the mock's own grey: muted text on a selected/hovered row's fill measures 5.8:1 (Dark), 5.1:1 (Obsidian) and 9.8:1 (Dark, high contrast) using `--muted-foreground`; the mock's own `#737373` measures 3.2:1 to 3.8:1 on the same fills, under the 4.5:1 text floor.

## Status line type

Decided 2026-10-16 (issue #928, v0.3.0 feedback item 5): the composer status line's chips (changes, context, elapsed, todo, subagents, pull request, current time) read 13px text and 14px icons, up from the original 12px/12px -- Stuart chose this over a 14px TEXT step, which would read "as loud as the chat". No existing Tailwind step is 13px (`text-xs` is 12px, `text-sm` is 14px), so this adds the one named step, `--text-readout` (globals.css), generating the `text-readout` utility rather than a bare `text-[13px]` arbitrary value.

| Element | Classes |
| --- | --- |
| Status line chip text (`ReadoutChip.tsx`) | `text-readout text-muted-foreground` (13px) |
| Status line chip icon (`ReadoutChip.tsx`) | `size-3.5` (14px) |

Scoped to `ReadoutChip.tsx` alone, the status line's own shared baseline component -- nothing else reads `text-readout` today.


## Spacing grid

Use a 4px grid with five allowed steps for padding, margin, and gap; control and icon sizes follow the control-height and icon-size ladders instead, not this grid. Never use an arbitrary pixel value in a component; the #474 audit found raw values (`p-1.5`, `p-0.5`, `gap-1.5`, `size-2.5`) outside this scale.

| Step | Tailwind class |
| --- | --- |
| 4px | `1` |
| 8px | `2` |
| 12px | `3` |
| 16px | `4` |
| 24px | `6` |

## Control heights

Control heights are 24, 28, and 32px (`xs`/`icon-xs`, `sm`/`icon-sm`, `default`/`icon`), following the button sizes decided in agenda item 8.

| Height | Button size | Icon-only size |
| --- | --- | --- |
| 24px | `xs` | `icon-xs` |
| 28px | `sm` | `icon-sm` |
| 32px | `default` | `icon` |

`button.tsx` also defines `lg` and `icon-lg` (36px); these are not part of the system, the same rule agenda item 4 applies to the unused `secondary` and `link` variants.

## Transcript rhythm

Keep the rhythm as built (`Transcript.tsx`): `mt-6` (24px) between turns and real user/assistant messages, and `mt-1` (4px) inside a run of consecutive bookkeeping rows (tool calls, thinking, notices). This settles #360.

## Panel header height

Use one fixed-height header row for every panel and pane (chat, Agents, Pull requests, FDB panes, side chat): title left, ghost icon-only actions right. **No bottom divider line** (Stuart, 2026-10-09): the header is separated from its content by a different surface shade and/or whitespace, not a border -- see "Panel header" in [components.md](components.md#panel-header).

The agenda item 8 decision proposed 40px, pending a measurement against today's chat header. Measured: `ChatHeader.tsx`'s `<header>` carries `flex h-10 shrink-0 items-center ... px-4`, with no bottom border -- #606 removed it outright, which is the accepted rule above, not a gap. Tailwind's `h-10` sets `height: 2.5rem` (40px at the project's default 16px root font size). Measured height: **40px**, confirming the proposed value — adopt 40px as the one panel header height everywhere.

## Reading width

Reading width is a Setting, defaulting to full width (#554, decided). Chat text already fills the full width of the transcript column, so the default needs no component change; a narrower reading width is a later Settings addition.
