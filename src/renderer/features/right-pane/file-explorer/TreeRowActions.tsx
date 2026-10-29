// Inline row actions for a File explorer tree row (spec 035, #756): the shared path-action
// buttons (`path-actions.tsx`) between the name/status mark and the kebab. They are mouse
// shortcuts only (`tabIndex={-1}`, grill 2026-10-29): the keyboard route stays the kebab menu and
// Shift+F10. How many show follows the PANE's width, via a container query on the Explorer
// panel's `@container` root: below 300px none; 300px up to 380px Open in VS Code + Copy path; 380px
// and wider all three. Tailwind needs the literals in the class strings below, so keep them in
// step with these two numbers.
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
        openInVSCode: `${reveal} hidden @min-[300px]:inline-flex`,
        reveal: `${reveal} hidden @min-[380px]:inline-flex`,
        copyPath: `${reveal} hidden @min-[300px]:inline-flex`
      }}
    />
  )
}
