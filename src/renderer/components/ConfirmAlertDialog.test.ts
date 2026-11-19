// The repo has no jsdom and Radix portals render nothing on the server, so the Radix parts are replaced
// by plain elements and the dialog's element tree is walked directly (the dialog holds no hooks).
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AlertDialogAction, AlertDialogCancel } from '@/components/ui/alert-dialog'
import { ConfirmAlertDialog } from './ConfirmAlertDialog'

vi.mock('@/components/ui/alert-dialog', () => {
  const passthrough = (tag: string) => ({ children }: { children?: ReactNode }) => createElement(tag, null, children)
  return {
    AlertDialog: passthrough('div'),
    AlertDialogContent: passthrough('div'),
    AlertDialogHeader: passthrough('div'),
    AlertDialogFooter: passthrough('div'),
    AlertDialogTitle: passthrough('h2'),
    AlertDialogDescription: passthrough('p'),
    AlertDialogCancel: passthrough('button'),
    AlertDialogAction: passthrough('button')
  }
})

type DialogProps = Parameters<typeof ConfirmAlertDialog>[0]

function dialog(over: Partial<DialogProps> = {}): ReactElement {
  return ConfirmAlertDialog({
    open: true,
    busy: false,
    title: 'Title',
    description: 'Description',
    confirmLabel: 'Archive all',
    onCancel: () => undefined,
    onCloseAutoFocus: () => undefined,
    ...over
  } as DialogProps) as ReactElement
}

/** Every element of the tree whose type is `type`, in DOM order. */
function find(node: ReactNode, type: unknown, found: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  Children.forEach(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return
    if (child.type === type) found.push(child)
    find(child.props.children as ReactNode, type, found)
  })
  return found
}

function click(element: ReactElement<Record<string, unknown>>): { prevented: boolean } {
  const state = { prevented: false }
  ;(element.props.onClick as (event: { preventDefault(): void }) => void)({ preventDefault: () => (state.prevented = true) })
  return state
}

describe('ConfirmAlertDialog secondary action', () => {
  it('renders Cancel, the secondary and the confirm in that DOM order', () => {
    const tree = dialog({ secondaryLabel: 'Archive parent only', onSecondary: () => undefined })
    const cancel = find(tree, AlertDialogCancel)
    const actions = find(tree, AlertDialogAction)
    expect(cancel).toHaveLength(1)
    expect(actions.map((action) => action.props.children)).toEqual(['Archive parent only', 'Archive all'])
    expect(actions[0]?.props.variant).toBe('outline')
  })

  it('renders no secondary for existing callers', () => {
    const actions = find(dialog(), AlertDialogAction)
    expect(actions.map((action) => action.props.children)).toEqual(['Archive all'])
  })

  it('renders no secondary without a confirm action', () => {
    const tree = dialog({ confirmLabel: undefined, secondaryLabel: 'Archive parent only', onSecondary: () => undefined })
    expect(find(tree, AlertDialogAction)).toHaveLength(0)
  })

  it('calls onSecondary on click without letting Radix close the dialog', () => {
    const onSecondary = vi.fn()
    const [secondary] = find(dialog({ secondaryLabel: 'Archive parent only', onSecondary }), AlertDialogAction) as [ReactElement<Record<string, unknown>>]
    expect(click(secondary).prevented).toBe(true)
    expect(onSecondary).toHaveBeenCalledOnce()
  })

  it('is inert and aria-disabled while busy, as are the other buttons', () => {
    const onSecondary = vi.fn()
    const onConfirm = vi.fn()
    const tree = dialog({ busy: true, secondaryLabel: 'Archive parent only', onSecondary, onConfirm })
    const [secondary, confirm] = find(tree, AlertDialogAction) as [ReactElement<Record<string, unknown>>, ReactElement<Record<string, unknown>>]
    click(secondary)
    click(confirm)
    expect(onSecondary).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(secondary.props['aria-disabled']).toBe(true)
    expect(confirm.props['aria-disabled']).toBe(true)
  })
})
