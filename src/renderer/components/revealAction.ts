import { FolderOpenIcon } from 'lucide-react'

/** The one label and icon for every action that reveals a path in File Explorer ("Show", never "Open": #1420). */
export const REVEAL_ACTION_LABEL = 'Show in File Explorer'
export const RevealActionIcon = FolderOpenIcon

/** Accessible name and tooltip text; add `target` only where the control has no visible context for it. */
export function revealActionName(target?: string): string {
  return target ? `${REVEAL_ACTION_LABEL}: ${target}` : REVEAL_ACTION_LABEL
}
