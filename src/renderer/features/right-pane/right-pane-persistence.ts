import { DEFAULT_RIGHT_PANE, type RightPaneSettings } from '../../../shared/rightPane'
import {
  RIGHT_PANE_MAX_WIDTH_PX,
  RIGHT_PANE_MIN_WIDTH_PX,
  useRightPaneStore
} from '../../state/right-pane-store'
import { HOSTED_PANELS, type PanelId } from './panel-registry'

// Spec 024 FR-005 to FR-007 (#538): the single writer of `Settings.rightPane`, mirroring
// `pull-requests-layout-store.ts`'s debounced persist. `restoreRightPane` seeds the store from
// the saved row without writing back; the subscription then saves only genuine changes.

function isPanelId(id: string): id is PanelId {
  return HOSTED_PANELS.some((panel) => panel.id === id)
}

let lastSaved = ''
let timer: number | undefined
let started = false

function snapshot(): RightPaneSettings {
  const { open, widthPx, openPanelIds, activePanelId } = useRightPaneStore.getState()
  return { open, widthPx: Math.round(widthPx), openPanelIds: [...openPanelIds], activePanelId }
}

export function restoreRightPane(saved: RightPaneSettings | undefined): void {
  const source = saved ?? DEFAULT_RIGHT_PANE
  const openPanelIds = Array.isArray(source.openPanelIds) ? source.openPanelIds.filter(isPanelId) : []
  const active = source.activePanelId
  useRightPaneStore.getState().restore({
    open: source.open,
    widthPx: Math.min(RIGHT_PANE_MAX_WIDTH_PX, Math.max(RIGHT_PANE_MIN_WIDTH_PX, source.widthPx)),
    openPanelIds,
    activePanelId: active && openPanelIds.includes(active as PanelId) ? (active as PanelId) : (openPanelIds.at(-1) ?? null)
  })
  lastSaved = JSON.stringify(snapshot())
}

function save(): void {
  timer = undefined
  const next = snapshot()
  const serialised = JSON.stringify(next)
  if (serialised === lastSaved) return
  lastSaved = serialised
  window.refract.settings.setRightPane(next).then(
    (result) => {
      if (!result.ok) console.error('settings.setRightPane failed', result.error)
    },
    (err: unknown) => console.error('settings.setRightPane threw', err)
  )
}

/** Call once after `restoreRightPane`; later calls are no-ops. */
export function startRightPanePersistence(): void {
  if (started) return
  started = true
  window.addEventListener('pagehide', () => {
    if (timer === undefined) return
    clearTimeout(timer)
    save()
  })
  useRightPaneStore.subscribe((state, prev) => {
    if (
      state.open === prev.open &&
      state.widthPx === prev.widthPx &&
      state.openPanelIds === prev.openPanelIds &&
      state.activePanelId === prev.activePanelId
    ) {
      return
    }
    if (timer !== undefined) clearTimeout(timer)
    timer = window.setTimeout(save, 300)
  })
}
