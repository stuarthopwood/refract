// The non-drag way to resize the right pane (spec 013 FR-025, WCAG 2.5.7): one list of width
// choices rendered by two shells, the resize handle's context menu (right-click, Shift+F10 or the
// menu key) and the app menu bar's "Right pane" dropdown (AppMenuBar.tsx), so the two never drift.
import { Maximize2Icon, Minimize2Icon, PanelRightCloseIcon, PanelRightIcon } from 'lucide-react'
import {
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import {
  RIGHT_PANE_DEFAULT_WIDTH_PX,
  RIGHT_PANE_MAX_WIDTH_PX,
  RIGHT_PANE_MIN_WIDTH_PX,
  useRightPaneStore,
  useViewStore
} from '@/state'
import { rightPaneRef } from './right-pane-handle'
import { toggleRightPane } from './toggle-right-pane'

export const PANE_WIDTH_CHOICES = [
  { label: 'Narrow', widthPx: RIGHT_PANE_MIN_WIDTH_PX, icon: Minimize2Icon },
  { label: 'Default', widthPx: RIGHT_PANE_DEFAULT_WIDTH_PX, icon: PanelRightIcon },
  { label: 'Wide', widthPx: RIGHT_PANE_MAX_WIDTH_PX, icon: Maximize2Icon }
] as const

/** Sets the pane to a preset width, opening it first when it is collapsed. */
export function setPaneWidth(widthPx: number): void {
  const store = useRightPaneStore.getState()
  if (store.open) {
    rightPaneRef.current?.resize(widthPx)
    return
  }
  // App.tsx's layout effect resizes the panel to `widthPx` as it expands.
  store.setWidth(widthPx)
  store.toggleCollapsed()
}

export function closePane(): void {
  if (useRightPaneStore.getState().open) toggleRightPane()
}

/** The radio value that marks the current width; empty when the width is not a preset. */
function useCurrentChoice(): string {
  const widthPx = useRightPaneStore((s) => s.widthPx)
  const open = useRightPaneStore((s) => s.open)
  return open && PANE_WIDTH_CHOICES.some((c) => c.widthPx === Math.round(widthPx)) ? String(Math.round(widthPx)) : ''
}

function choiceText(label: string, widthPx: number): string {
  return `${label} (${widthPx} px)`
}

export function PaneWidthContextMenuItems() {
  const current = useCurrentChoice()
  const open = useRightPaneStore((s) => s.open)
  const canAct = useViewStore((s) => s.view) === 'chat'
  return (
    <>
      <ContextMenuRadioGroup value={current} onValueChange={(value) => setPaneWidth(Number(value))}>
        {PANE_WIDTH_CHOICES.map((choice) => (
          <ContextMenuRadioItem key={choice.widthPx} icon={choice.icon} value={String(choice.widthPx)} disabled={!canAct}>
            {choiceText(choice.label, choice.widthPx)}
          </ContextMenuRadioItem>
        ))}
      </ContextMenuRadioGroup>
      <ContextMenuSeparator />
      <ContextMenuItem icon={PanelRightCloseIcon} onSelect={closePane} disabled={!canAct || !open}>
        Close pane
      </ContextMenuItem>
    </>
  )
}

export function PaneWidthDropdownItems() {
  const current = useCurrentChoice()
  const open = useRightPaneStore((s) => s.open)
  const canAct = useViewStore((s) => s.view) === 'chat'
  return (
    <>
      <DropdownMenuRadioGroup value={current} onValueChange={(value) => setPaneWidth(Number(value))}>
        {PANE_WIDTH_CHOICES.map((choice) => (
          <DropdownMenuRadioItem key={choice.widthPx} icon={choice.icon} value={String(choice.widthPx)} disabled={!canAct}>
            {choiceText(choice.label, choice.widthPx)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem icon={PanelRightCloseIcon} onSelect={closePane} disabled={!canAct || !open}>
        Close pane
      </DropdownMenuItem>
    </>
  )
}
