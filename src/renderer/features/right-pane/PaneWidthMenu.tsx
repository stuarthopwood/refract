// The non-drag way to resize the right pane (spec 013 FR-025, WCAG 2.5.7): one list of width
// choices rendered by two shells, the resize handle's context menu (right-click, Shift+F10 or the
// menu key) and the app menu bar's "Right pane" dropdown (AppMenuBar.tsx), so the two never drift.
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
  useRightPaneStore
} from '@/state'
import { rightPaneRef } from './right-pane-handle'
import { toggleRightPane } from './toggle-right-pane'

export const PANE_WIDTH_CHOICES = [
  { label: 'Narrow', widthPx: RIGHT_PANE_MIN_WIDTH_PX },
  { label: 'Default', widthPx: RIGHT_PANE_DEFAULT_WIDTH_PX },
  { label: 'Wide', widthPx: RIGHT_PANE_MAX_WIDTH_PX }
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
  return (
    <>
      <ContextMenuRadioGroup value={current} onValueChange={(value) => setPaneWidth(Number(value))}>
        {PANE_WIDTH_CHOICES.map((choice) => (
          <ContextMenuRadioItem key={choice.widthPx} value={String(choice.widthPx)}>
            {choiceText(choice.label, choice.widthPx)}
          </ContextMenuRadioItem>
        ))}
      </ContextMenuRadioGroup>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={closePane}>Close pane</ContextMenuItem>
    </>
  )
}

export function PaneWidthDropdownItems() {
  const current = useCurrentChoice()
  return (
    <>
      <DropdownMenuRadioGroup value={current} onValueChange={(value) => setPaneWidth(Number(value))}>
        {PANE_WIDTH_CHOICES.map((choice) => (
          <DropdownMenuRadioItem key={choice.widthPx} value={String(choice.widthPx)}>
            {choiceText(choice.label, choice.widthPx)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={closePane}>Close pane</DropdownMenuItem>
    </>
  )
}
