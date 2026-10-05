# Data model: Brand watermark

Extends [spec 001's data-model.md](../001-core-session-workspace/data-model.md) and the
`Settings` extensions already made by [spec 004](../004-session-readout/data-model.md),
[spec 005](../005-split-chat-pane/data-model.md), and [spec 007](../007-app-themes/data-model.md).
This file only lists what this spec adds or changes. Terms follow
[CONTEXT.md](../../CONTEXT.md).

## Extended `Settings` (`src/shared/model.ts`, `settings.json`)

```ts
export interface Settings {
  version: 1;
  approvalMode: ApprovalMode;
  sessionReadout: Record<ReadoutKind, boolean>;
  split: SplitLayout | null;
  theme: ThemeId;
  watermarkEnabled: boolean;   // new (FR-015): default true
}
```

**Default (FR-015)**: `true` — the mark shows unless the developer turns it off, matching Stuart's
own phrasing ("which can be toggled off").

**Migration (FR-019)**: an existing `settings.json` written before this spec has no
`watermarkEnabled` key at all. `SettingsStore.open` (`src/main/store/settings.ts`) must treat a
missing key the same way it already treats a missing `sessionReadout` (spec 004) or `split` (spec
005): a field-level merge under the default (`true`), not a whole-file fallback.

**Validation (FR-020)**: a loaded value that is present but not a boolean (a hand-edited or
otherwise corrupt file) is corrected to `true` in memory on read, the same lazy-correction pattern
`SettingsStore.open` already applies to an unrecognised `theme` value (spec 007 data-model.md) and
an invalid `split` shape (spec 005) — the stored value is only overwritten on disk the next time
the developer actually uses the switch (`setWatermarkEnabled`'s own write), never silently rewritten
by an unrelated setter's whole-row persist, the same race-safety rule `rawTheme` already protects
for `theme` (`src/main/store/settings.ts`).

## No new shared metadata table

Unlike spec 007's `src/shared/themes.ts` (`THEMES`, keyed by `ThemeId`), this spec introduces no
new per-variant metadata table: there is exactly one mark, one opacity constant, and one asset
(research.md decisions 4, 5, 12) — a single boolean is the entire new unit of stored data.

## Held in memory: renderer (`settings-store.ts`)

Extends the existing store (no new store file):

```ts
interface SettingsState {
  settings: Settings;               // now includes watermarkEnabled
  setSettings(settings: Settings): void;
  setApprovalMode(mode: ApprovalMode): Promise<void>;
  setReadoutVisibility(kind: ReadoutKind, visible: boolean): Promise<void>;
  setWatermarkEnabled(enabled: boolean): Promise<void>;   // new
}
```

`setWatermarkEnabled` follows the exact same body shape as `setReadoutVisibility`: call
`window.refract.settings.setWatermarkEnabled(enabled)`, `set({ settings: result.value })` on
success, `notify(result.error)` on failure.

## Renderer-only: the mark itself

No new zustand store. `BrandWatermark.tsx` (new component, `src/renderer/features/chat/`) is a pure
function of `useSettingsStore((s) => s.settings.watermarkEnabled)`: renders nothing (`null`) when
`false`, otherwise the mask-image box described in research.md decisions 4-8. It takes one prop,
`variant: 'live' | 'preview'` (research.md decision 9):

```ts
interface BrandWatermarkProps {
  /** 'live': the real, responsively-clamped corner mark, mounted inside whichever of
   *  ChatPane.tsx's own eligible render branches is active (research.md decision 3). 'preview':
   *  a small, fixed-size rendering inside the Appearance section, sharing the same
   *  mask-image/colour/opacity but not the responsive clamp or corner anchor. */
  variant: 'live' | 'preview';
}
```

Both variants read the same `watermarkEnabled` state; `variant: 'preview'` additionally ignores
`FR-011`'s full-screen suppression rule, since it is explicitly meant to render inside Settings
(research.md decision 9).

### Extended `ChatPaneProps` (`src/renderer/features/chat/ChatPane.tsx`)

```ts
interface ChatPaneProps {
  sessionId: string;
  paneIndex: number;
  reservesWindowControls: boolean;
  otherSession: { id: string; name: string } | null;
  /** New (research.md decisions 3, 8): true for exactly one rendered ChatPane at a time — the
   *  single pane shown when there is only one, or the right (second, paneIndex 1) pane of a true
   *  two-pane split. App.tsx computes and passes this; ChatPane itself does not infer it from
   *  useSplitStore. Mounts <BrandWatermark variant="live" /> in this pane's transcript container
   *  (the normal case) or its own `!session` Empty fallback, whichever branch is active. */
  showWatermark?: boolean;
}
```


## Cross-spec data notes

- **Settings screen host (spec 004)** and **Appearance section (spec 007)**: the new switch and
  preview are added inside `AppearanceSection.tsx`, already built on `main` in this checkout — no
  new section or screen is created.
- **Split chat pane (spec 005)**: `BrandWatermark`'s `'live'` instance is mounted inside whichever
  `ChatPane` instance receives `showWatermark` (the right pane of a true split, or the single
  pane), never both and never the left pane (research.md decisions 3, 8) — this spec reads no
  split-store state directly; `App.tsx` already computes the single/right-pane distinction for its
  own rendering and simply forwards it.
- **Theme tokens (spec 007)**: the mark's colour is `var(--muted-foreground)`, already declared in
  every `.theme-*` block; this spec adds no new theme-specific token, only the one
  theme-independent `--watermark-opacity` constant in `:root` (research.md decision 5).
- **Prerequisite brand asset** (branch `brand-icon-v2`, not yet merged into `main`): this data
  model assumes `src/renderer/assets/brand/refract-hero.svg` already exists at the path and square
  viewBox described in spec.md's "Prerequisite" section; this spec adds no shared type describing
  that asset, since it is referenced only by a literal CSS `url()`, the same way
  `Readiness.tsx` already imports it as a plain asset URL.
