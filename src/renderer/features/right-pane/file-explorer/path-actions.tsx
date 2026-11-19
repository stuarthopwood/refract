// The one definition of the three path actions (spec 036, #756): Open in VS Code, Show in File
// Explorer and Copy path. Their labels, icons and handlers live here once; the tree row's inline
// buttons (`TreeRowActions`), the preview header (`FilePreviewPane`) and the row's kebab/context
// menu items (`TreeNodeRow`) are all built from them.
import { useEffect, useState } from 'react'
import { CopyIcon, Code2Icon, type LucideIcon } from 'lucide-react'
import { REVEAL_ACTION_LABEL, RevealActionIcon } from '@/components/revealAction'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export type PathActionKey = 'openInVSCode' | 'reveal' | 'copyPath'

export const PATH_ACTIONS: ReadonlyArray<{ key: PathActionKey; label: string; icon: LucideIcon }> = [
  { key: 'openInVSCode', label: 'Open in VS Code', icon: Code2Icon },
  { key: 'reveal', label: REVEAL_ACTION_LABEL, icon: RevealActionIcon },
  { key: 'copyPath', label: 'Copy path', icon: CopyIcon }
]

/** Handlers already bound to one path. */
export interface PathActionHandlers {
  openInVSCode: () => void
  reveal: () => void
  /** Resolves `true` when the path reached the clipboard. `confirm` adds the "Path copied" toast:
   * only for a menu item, which has no inline check or live region of its own. */
  copyPath: (confirm?: boolean) => Promise<boolean>
}

interface PathActionButtonsProps {
  handlers: PathActionHandlers
  disabled?: boolean
  tabIndex?: number
  /** Per-action extra classes (reveal, container-query visibility). */
  classNames?: Partial<Record<PathActionKey, string>>
}

/** Ghost icon-only buttons (tooltip text == aria-label). Copy is the shared `CopyButton`, which
 * owns the check swap and the single polite "Path copied" announcement. */
export function PathActionButtons({ handlers, disabled, tabIndex, classNames }: PathActionButtonsProps) {
  return (
    <>
      {PATH_ACTIONS.map(({ key, label, icon: Icon }) =>
        key === 'copyPath' ? (
          <CopyButton
            key={key}
            label={label}
            announcement="Path copied"
            onCopy={() => handlers.copyPath()}
            tabIndex={tabIndex}
            disabled={disabled}
            className={classNames?.copyPath}
          />
        ) : (
          <Tooltip key={key}>
            <TooltipTrigger asChild aria-describedby={undefined}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                tabIndex={tabIndex}
                disabled={disabled}
                aria-label={label}
                className={`shrink-0 ${classNames?.[key] ?? ''}`}
                // The tree row carries `onClick`; a click here must not also select/open/toggle it.
                onClick={(event) => {
                  event.stopPropagation()
                  handlers[key]()
                }}
              >
                <Icon aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        )
      )}
    </>
  )
}

/** The callbacks a document view takes, bound to a path by `DocumentPathActions` (the shape `usePathActionHandlers` returns). */
export interface PathActionCallbacks {
  onOpenInVSCode: (path: string) => Promise<boolean>
  onReveal: (path: string) => Promise<void>
  onCopyPath: (path: string, confirm?: boolean) => Promise<boolean>
}

interface DocumentPathActionsProps extends PathActionCallbacks {
  path: string
  disabled?: boolean
}

/** The path buttons of a document header (file and diff tabs), with the transient "VS Code not found" status the tree row menu also shows. */
export function DocumentPathActions({ path, disabled, onOpenInVSCode, onReveal, onCopyPath }: DocumentPathActionsProps) {
  const [vscodeNotFound, setVscodeNotFound] = useState(false)
  useEffect(() => {
    if (!vscodeNotFound) return
    const timer = setTimeout(() => setVscodeNotFound(false), 5000)
    return () => clearTimeout(timer)
  }, [vscodeNotFound])

  const handlers: PathActionHandlers = {
    openInVSCode: () => void onOpenInVSCode(path).then((opened) => setVscodeNotFound(!opened)),
    reveal: () => void onReveal(path),
    copyPath: (confirm) => onCopyPath(path, confirm)
  }
  return (
    <>
      {vscodeNotFound && (
        <span role="status" className="shrink-0 text-xs text-muted-foreground">
          VS Code not found
        </span>
      )}
      <PathActionButtons handlers={handlers} disabled={disabled} />
    </>
  )
}
