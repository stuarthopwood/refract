# Data model: App themes

Extends [spec 001's data-model.md](../001-core-session-workspace/data-model.md). Terms follow
[CONTEXT.md](../../CONTEXT.md).

## New shared types (`src/shared/themes.ts`)

```ts
export type ThemeId = 'light' | 'dark' | 'high-contrast';
export type ThemeSetting = 'system' | ThemeId;

export interface ThemeDefinition {
  id: ThemeId;
  name: string;                 // "Light", "Dark", "High contrast" — shown in the picker
  mode: 'light' | 'dark';       // which System-mode match and Sonner forcedTheme bucket this theme belongs to
  swatch: string;               // a representative CSS colour shown next to `name` in the picker
  syntaxTheme: string;          // a Shiki bundled theme id (research.md decision 9)
  titleBarOverlay: {             // BrowserWindow.setTitleBarOverlay, spec 001 T100
    color: string;
    symbolColor: string;
  };
}

export const THEMES: Record<ThemeId, ThemeDefinition>;
```

`THEMES` has exactly three entries for this spec (research.md decision 1): `light`, `dark`,
`high-contrast`. Picker order is `'system'` first, then `THEMES.light`, `THEMES.dark`,
`THEMES.high-contrast` (FR-003).

## Extended `Settings` (`src/shared/model.ts`, `settings.json`)

```ts
export interface Settings {
  version: 1;
  approvalMode: ApprovalMode;
  theme: ThemeSetting;   // default 'system' (FR-001)
}
```

Rule (FR-016): if a loaded `settings.json`'s `theme` is neither `'system'` nor a key of `THEMES`
(for example, a theme an app update removed), Refract treats it as `'system'` for every purpose —
the bootstrap read, the picker's marked entry, and `theme-store.ts`'s derivation — without
requiring a save; the stored value is only corrected the next time the developer actually saves a
theme choice.

## Held in memory: `theme-store.ts` (renderer)

```ts
interface ThemeStoreState {
  settingsTheme: ThemeSetting;   // mirrors Settings.theme; starts from the bootstrap read
  osDark: boolean;               // mirrors nativeTheme.shouldUseDarkColors; starts from the bootstrap read, then theme:os-changed
  previewing: ThemeId | null;    // non-null only while an unsaved preview (Appearance section or profile submenu) is open
}
```

Derived (never stored separately, always recomputed):

```ts
function activeThemeId(s: ThemeStoreState): ThemeId {
  if (s.previewing) return s.previewing;
  if (s.settingsTheme === 'system') return s.osDark ? 'dark' : 'light';
  return s.settingsTheme in THEMES ? s.settingsTheme : 'light'; // FR-016 fallback resolves 'system' upstream; this is the last-resort default if even that lookup fails
}
```

`document.documentElement`'s class is always exactly `theme-${activeThemeId(state)}`, replacing
today's single hardcoded `.dark` class (research.md decision 2).

## State transitions

| From | Event | To |
|---|---|---|
| no preview, any `settingsTheme` | picker entry highlighted/selected, or profile submenu entry hovered/selected | `previewing = <id>` (FR-005) |
| `previewing = <id>` | Save | `settingsTheme = <id>`, `previewing = null` (FR-006) |
| `previewing = <id>` | Cancel, Esc, or navigating away from Settings | `previewing = null` (FR-007) |
| `previewing = <id>`, picker shows "System" chosen | Save | `settingsTheme = 'system'`, `previewing = null` (FR-008) |
| any, `settingsTheme === 'system'`, `previewing === null` | `theme:os-changed` event | `osDark` updates live (FR-002) |
| any, `settingsTheme === 'system'`, `previewing !== null` | `theme:os-changed` event | `osDark` updates in the background; not applied until `previewing` clears (FR-021) |
| app relaunch | bootstrap read | `settingsTheme`/`osDark` re-seeded from `settings.json`/`nativeTheme`; `previewing` always starts `null` — an unsaved preview never survives a restart (FR-022) |

## Cross-spec data notes

- **Settings screen host (spec 004)**: the Appearance section is a new section inside spec 004's
  Settings screen component tree; this spec does not define that screen's shell, only the section
  mounted inside it.
- **Split chat pane (spec 005)** and **a second window**: every `BrowserWindow` Refract creates
  must answer `theme:bootstrap` the same way the main window does (FR-014); this data model adds
  no per-window theme state, since the theme setting is app-wide (Assumptions), not per-window or
  per-Session.
- **Profile menu (spec 008)**: its Theme submenu calls the same `theme-store.ts` actions
  (`preview`, `save`) this spec defines; it introduces no new theme data of its own.
