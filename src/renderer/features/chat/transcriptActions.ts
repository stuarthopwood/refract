import {
  ArrowUpToLineIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CopyIcon,
  DownloadIcon,
  FileCodeIcon,
  FileTextIcon,
  ImageIcon,
  TerminalIcon,
  TextSelectIcon,
  WrapTextIcon
} from 'lucide-react'
import { registerActions, type PaletteAction } from '@/features/palette/actionRegistry'

function menuAction(id: string, label: string, icon: PaletteAction['icon']): PaletteAction {
  return { id, label, icon, group: 'Transcript', menuOnly: true, when: () => true, run: () => undefined }
}

/** Menu-only actions for transcript surfaces; each menu supplies `onSelect` for its own target. */
const TRANSCRIPT_ACTIONS: readonly PaletteAction[] = [
  menuAction('transcript.copy-selection', 'Copy selection', TextSelectIcon),
  menuAction('transcript.copy-message', 'Copy', CopyIcon),
  menuAction('transcript.copy-message-plain', 'Copy as plain text', FileTextIcon),
  menuAction('transcript.scroll-to-prompt', 'Scroll to your message', ArrowUpToLineIcon),
  menuAction('transcript.copy-code', 'Copy code', CopyIcon),
  menuAction('transcript.wrap-lines', 'Wrap lines', WrapTextIcon),
  menuAction('transcript.expand', 'Expand', ChevronsUpDownIcon),
  menuAction('transcript.collapse', 'Collapse', ChevronsDownUpIcon),
  menuAction('transcript.copy-command', 'Copy command', TerminalIcon),
  menuAction('transcript.copy-output', 'Copy output', CopyIcon),
  menuAction('transcript.mermaid-copy-source', 'Copy source', FileCodeIcon),
  menuAction('transcript.mermaid-copy-image', 'Copy as image', ImageIcon),
  menuAction('transcript.mermaid-save-image', 'Save image…', DownloadIcon)
]

registerActions(TRANSCRIPT_ACTIONS)
