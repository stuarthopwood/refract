# Data model: App themes

Extends [spec 001's data-model.md](../001-core-session-workspace/data-model.md). Terms follow
[CONTEXT.md](../../CONTEXT.md).

## New shared types (`src/shared/themes.ts`)

```ts
export type ThemeId = 'dark' | 'dark-high-contrast'; // open union: a further dark preset adds a key, never removes these two

export interface ThemeDefinition {
  id: ThemeId;
  name: string;                 // "Dark", "Dark (high contrast)" — shown in the picker
  swatch: string;               // a representative CSS colour shown next to `name` in the picker
  syntaxTheme: string;          // a Shiki bundled theme id (research.md decision 9)
  titleBarOverlay: {             // BrowserWindow.setTitleBarOverlay, spec 001 T100
    color: string;
    symbolColor: string;
  };
}

export const THEMES: Record<ThemeId, ThemeDefinition>;
```

`ThemeDefinition` carries no `mode` field: every built-in theme is dark-toned (research.md
decision 1), so there is nothing left to distinguish by mode. Sonner's toast theming instead reads
a hardcoded `'dark'` constant (research.md decision 11), not a per-theme field.

`THEMES` has at least two entries for this spec (research.md decision 1): `dark` (the existing
single dark theme, now a named preset) and `dark-high-contrast`. The exact count and names of any
further preset are an open question for Stuart (spec.md Assumptions). Picker order is
`THEMES.dark`, `THEMES['dark-high-contrast']`, then any further preset in declaration order
(FR-001).

## Extended `Settings` (`src/shared/model.ts`, `settings.json`)

```ts
export interface Settings {
  version: 1;
  approvalMode: ApprovalMode;
  theme: ThemeId;   // default 'dark' (FR-001's default preset)
}
```

Rule (FR-013): if a loaded `settings.json`'s `theme` is not a key of `THEMES` (for example, a
theme an app update removed), Refract treats it as the default preset (`'dark'`) for every
purpose — the bootstrap read, the picker's marked entry, and `theme-store.ts`'s derivation —
without requiring a save; the stored value is only corrected the next time the developer actually
saves a theme choice.

## Held in memory: `theme-store.ts` (renderer)

```ts
interface ThemeStoreState {
  theme: ThemeId;                 // mirrors Settings.theme; starts from the bootstrap read
  previewing: ThemeId | null;    // non-null only while an unsaved preview (Appearance section or profile submenu) is open
}
```

Derived (never stored separately, always recomputed):

```ts
function activeThemeId(s: ThemeStoreState): ThemeId {
  if (s.previewing) return s.previewing;
  return s.theme in THEMES ? s.theme : 'dark'; // FR-013 fallback resolves on read; this is the last-resort default if even that lookup fails
}
```

`document.documentElement`'s class is always exactly `theme-${activeThemeId(state)}`, replacing
today's single hardcoded `.dark` class (research.md decision 2).

## State transitions

| From | Event | To |
|---|---|---|
| no preview, any `theme` | picker entry highlighted/selected, or profile submenu entry hovered/selected | `previewing = <id>` (FR-003) |
| `previewing = <id>` | Save | `theme = <id>`, `previewing = null` (FR-004) |
| `previewing = <id>` | Cancel, Esc, or navigating away from Settings | `previewing = null` (FR-005) |
| app relaunch | bootstrap read | `theme` re-seeded from `settings.json`; `previewing` always starts `null` — an unsaved preview never survives a restart |

## Cross-spec data notes

- **Settings screen host (spec 004)**: the Appearance section is a new section inside spec 004's
  Settings screen component tree; this spec does not define that screen's shell, only the section
  mounted inside it.
- **Split chat pane (spec 005)** and **a second window**: every `BrowserWindow` Refract creates
  must answer `theme:bootstrap` the same way the main window does (FR-011); this data model adds
  no per-window theme state, since the theme setting is app-wide (Assumptions), not per-window or
  per-Session.
- **Profile menu (spec 008)**: its Theme submenu calls the same `theme-store.ts` actions
  (`preview`, `save`) this spec defines; it introduces no new theme data of its own.
