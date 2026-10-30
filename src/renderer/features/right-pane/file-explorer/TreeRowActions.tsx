// Inline row actions: mouse shortcuts only (`tabIndex={-1}`); the keyboard route is the kebab menu and Shift+F10.
// How many show follows the pane width via a container query: <300px none, 300-380px two, wider all three.
// The container is the panel's content box (p-2 = 16px), so the literals are 284 (300 - 16) and 365 (381 - 16).
import { PathActionButtons, type PathActionHandlers } from './path-actions'

interface TreeRowActionsProps {
  selected: boolean
  handlers: PathActionHandlers
}

export function TreeRowActions({ selected, handlers }: TreeRowActionsProps) {
  // Same reveal as the kebab: hover, focus-within or selected.
  const reveal = `focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 ${selected ? 'opacity-100' : 'opacity-0'}`
  return (
    <PathActionButtons
      handlers={handlers}
      tabIndex={-1}
      classNames={{
        openInVSCode: `${reveal} hidden @min-[284px]:inline-flex`,
        reveal: `${reveal} hidden @min-[365px]:inline-flex`,
        copyPath: `${reveal} hidden @min-[284px]:inline-flex`
      }}
    />
  )
}
