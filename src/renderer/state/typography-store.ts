// Spec 035 (#842): the three text-size scales (App, Chat, Code). The CSS variables
// `--scale-app|chat|code` (globals.css) are applied to <html> synchronously from the theme
// bootstrap on first paint, live while a control moves, and again when `settings:changed` brings a
// value from elsewhere. Persisting is debounced so a slider drag sends one write, not one per step.
import { create } from 'zustand'
import { DEFAULT_TYPOGRAPHY, TYPOGRAPHY_MAX_SCALE, TYPOGRAPHY_MIN_SCALE } from '../../shared/typography'
import type { Typography } from '../../shared/typography'
import { notify } from './notify'
import { useSettingsStore } from './settings-store'

const PERSIST_DEBOUNCE_MS = 300

export type TypographyRole = 'app' | 'chat' | 'code'
const ROLE_KEY: Record<TypographyRole, keyof Typography> = { app: 'appScale', chat: 'chatScale', code: 'codeScale' }
export const TYPOGRAPHY_ROLES: readonly TypographyRole[] = ['app', 'chat', 'code']

export function clampScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.min(TYPOGRAPHY_MAX_SCALE, Math.max(TYPOGRAPHY_MIN_SCALE, Math.round(value * 100) / 100))
}

export function normalizeTypography(value: Partial<Typography> | undefined): Typography {
  return {
    appScale: clampScale(value?.appScale),
    chatScale: clampScale(value?.chatScale),
    codeScale: clampScale(value?.codeScale)
  }
}

export function applyTypography(value: Typography): void {
  const style = document.documentElement.style
  style.setProperty('--scale-app', String(value.appScale))
  style.setProperty('--scale-chat', String(value.chatScale))
  style.setProperty('--scale-code', String(value.codeScale))
}

function sameTypography(a: Typography, b: Typography): boolean {
  return a.appScale === b.appScale && a.chatScale === b.chatScale && a.codeScale === b.codeScale
}

interface TypographyState {
  typography: Typography
  /** Applies and persists one role's scale (or all three with `setAll`). */
  setRole(role: TypographyRole, scale: number): void
  setAll(value: Typography): void
  /** Applies a value that came from the saved settings; ignored while a local edit is unsaved. */
  syncFromSettings(value: Typography | undefined): void
}

let persistTimer: ReturnType<typeof setTimeout> | null = null

export const useTypographyStore = create<TypographyState>((set, get) => {
  function commit(next: Typography): void {
    if (sameTypography(next, get().typography)) return
    set({ typography: next })
    applyTypography(next)
    if (persistTimer !== null) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      const save = window.refract.settings.setTypography
      if (typeof save !== 'function') return
      save(get().typography).then(
        (result) => {
          if (!result.ok) notify(result.error)
        },
        (err: unknown) => console.error('settings.setTypography threw', err)
      )
    }, PERSIST_DEBOUNCE_MS)
  }

  return {
    typography: DEFAULT_TYPOGRAPHY,
    setRole: (role, scale) => commit({ ...get().typography, [ROLE_KEY[role]]: clampScale(scale) }),
    setAll: (value) => commit(normalizeTypography(value)),
    syncFromSettings: (value) => {
      if (persistTimer !== null) return
      const next = normalizeTypography(value)
      if (sameTypography(next, get().typography)) return
      set({ typography: next })
      applyTypography(next)
    }
  }
})

/** Called once from `main.tsx` before React mounts, with the bootstrap's `typography` (absent on
 *  a shell that does not carry it, which means the defaults). */
export function initTypographyStore(bootstrap: Partial<Typography> | undefined): void {
  const initial = normalizeTypography(bootstrap)
  useTypographyStore.setState({ typography: initial })
  applyTypography(initial)
  // The settings load and every `settings:changed` broadcast land in the settings store.
  let last = useSettingsStore.getState().settings.typography
  useSettingsStore.subscribe((state) => {
    if (state.settings.typography === last) return
    last = state.settings.typography
    useTypographyStore.getState().syncFromSettings(last)
  })
}
