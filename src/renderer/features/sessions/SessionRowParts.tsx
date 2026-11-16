import type { ReactNode } from 'react'
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import type { SessionRowAction } from './sessionActions'
import type { useSessionRowActions } from './useSessionRowActions'

type RowState = ReturnType<typeof useSessionRowActions>

/** What the row's two menus share on open: a previous create or restore whose Radix close-autofocus
 *  never fired (superseded by this open) is settled first, before `createOriginRef` is overwritten,
 *  so the stashed finish still resolves the origin it belongs to. */
function settlePreviousActions(row: RowState): void {
  const settled = row.settledCreateRef.current
  row.settledCreateRef.current = null
  row.createRequestedRef.current = false
  settled?.()
  const settledRestore = row.settledRestoreRef.current
  row.settledRestoreRef.current = null
  row.restoreRequestedRef.current = false
  settledRestore?.()
}

export function onDropdownOpenChange(row: RowState, open: boolean): void {
  if (!open) return
  settlePreviousActions(row)
  row.createOriginRef.current = 'dropdown'
}

export function onContextMenuOpenChange(row: RowState, open: boolean): void {
  if (!open) return
  settlePreviousActions(row)
  row.createOriginRef.current = 'context'
  // Shift+F10 and the Menu key open this menu from whatever already has focus (for example the
  // "..." trigger), not always the open button: prefer that element when it is inside this row.
  const active = document.activeElement
  row.contextMenuOpenerRef.current = active instanceof HTMLElement && row.rowRef.current?.contains(active) ? active : null
}

/** The row's rename field, identical on every screen that renders the shared Session row. */
export function SessionRenameInput({ row }: { row: RowState }) {
  return (
    <input
      ref={row.renameInputRef}
      autoFocus
      value={row.draftName}
      onChange={(event) => row.setDraftName(event.target.value)}
      onBlur={() => void row.commitRename()}
      onKeyDown={row.handleNameKeyDown}
      aria-label="Session name"
      className="w-full min-w-0 flex-1 rounded border border-ring bg-transparent px-2 py-1 text-sm outline-none"
    />
  )
}

type ActionItem = Extract<SessionRowAction, { kind: 'item' }>

const REASON_ITEM_CLASS = 'aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:forced-colors:text-[GrayText]'

/** What an action item needs to be unavailable and still selectable by the menu's own machinery. */
interface ItemAvailability {
  disabled: boolean | undefined
  'aria-disabled': true | undefined
  'aria-describedby': string | undefined
  className: string | undefined
  onSelect: (event: Event) => void
}

/** A reason keeps the item focusable (`aria-disabled` plus a guarded `onSelect`, as in `ContextShakeMenu`) so keyboard
 * users reach it and hear why; without one the item is natively disabled when `disabled`. */
function availability(action: ActionItem, reasonId: string | undefined): ItemAvailability {
  return {
    disabled: action.reason ? undefined : action.disabled,
    'aria-disabled': action.reason ? true : undefined,
    'aria-describedby': reasonId,
    className: action.reason ? REASON_ITEM_CLASS : undefined,
    onSelect: (event) => {
      if (action.reason) event.preventDefault()
      else action.onSelect()
    }
  }
}

/** The label, plus the reason as the item's accessible description and a tooltip on hover and keyboard focus. */
function withReason(action: ActionItem, item: (props: ItemAvailability, label: ReactNode) => ReactNode): ReactNode {
  const label = <span className="min-w-0 whitespace-normal break-words">{action.label}</span>
  if (!action.reason) return item(availability(action, undefined), label)
  const reasonId = `session-action-${action.key}-reason`
  return (
    <Tooltip key={action.key}>
      <TooltipTrigger asChild>
        {item(
          availability(action, reasonId),
          <>
            {label}
            <span id={reasonId} className="sr-only">
              {action.reason}
            </span>
          </>
        )}
      </TooltipTrigger>
      <TooltipContent side="right">{action.reason}</TooltipContent>
    </Tooltip>
  )
}

/** One action list, two menus (the "..." dropdown and the right-click context menu). */
export function DropdownActionItems({ actions }: { actions: SessionRowAction[] }) {
  return actions.map((action, index) =>
    action.kind === 'separator' ? (
      <DropdownMenuSeparator key={`sep-${index}`} />
    ) : (
      withReason(action, (props, label) => (
        <DropdownMenuItem key={action.key} variant={action.variant} icon={action.icon} {...props}>
          {label}
        </DropdownMenuItem>
      ))
    )
  )
}

export function ContextActionItems({ actions }: { actions: SessionRowAction[] }) {
  return actions.map((action, index) =>
    action.kind === 'separator' ? (
      <ContextMenuSeparator key={`sep-${index}`} />
    ) : (
      withReason(action, (props, label) => (
        <ContextMenuItem key={action.key} variant={action.variant} icon={action.icon} {...props}>
          {label}
        </ContextMenuItem>
      ))
    )
  )
}
