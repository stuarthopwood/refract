import * as React from 'react'
import type { TranscriptItem } from '../../../shared/model'
import { actionMenuItem, menuSeparator, type MenuKind } from '@/features/palette/menuItems'
import { commandRowText } from './formatToolCommand'
import { copyLinkText } from './linkClipboard'
import { TranscriptKebab, TranscriptMenu } from './TranscriptMenu'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

interface ToolRowMenuProps {
  /** The single tool call this row stands for; a multi-call group passes none and gets no menu. */
  item: ToolItem | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

function toolRowItems(item: ToolItem | undefined, open: boolean, onOpenChange: (open: boolean) => void) {
  const output = item?.status === 'running' ? '' : (item?.output ?? '')
  return (kind: MenuKind) => {
    const command = item ? commandRowText(item) : ''
    return (
      <>
        {command !== '' &&
          actionMenuItem('transcript.copy-command', { kind, onSelect: () => void copyLinkText(command, 'Command copied', 'Nothing to copy: the command only contains hidden characters') })}
        {output !== '' &&
          actionMenuItem('transcript.copy-output', { kind, onSelect: () => void copyLinkText(output, 'Output copied', 'Nothing to copy: the output only contains hidden characters') })}
        {(command !== '' || output !== '') && menuSeparator(kind)}
        {actionMenuItem(open ? 'transcript.collapse' : 'transcript.expand', { kind, onSelect: () => onOpenChange(!open) })}
      </>
    )
  }
}

/** The row header's `More actions` kebab; absent while the call runs or for a multi-call group. */
export function ToolRowKebab({ item, open, onOpenChange }: Omit<ToolRowMenuProps, 'children'>) {
  if (!item || item.status === 'running') return null
  const command = commandRowText(item)
  return (
    <TranscriptKebab
      lazy
      items={toolRowItems(item, open, onOpenChange)}
      label={command === '' ? 'More actions' : `More actions for ${command.slice(0, 60)}`}
      className="opacity-0 transition-opacity motion-reduce:transition-none focus-visible:opacity-100 group-focus-within/tool-row:opacity-100 group-hover/tool-row:opacity-100 data-[state=open]:opacity-100"
    />
  )
}

/** The tool row's context menu (#471): copy the command and output, and expand or collapse the row; none while it runs. */
export function ToolRowMenu({ item, open, onOpenChange, children }: ToolRowMenuProps) {
  return (
    <TranscriptMenu
      disabled={!item || item.status === 'running'}
      items={toolRowItems(item, open, onOpenChange)}
      className={item ? 'group/tool-row' : undefined}
    >
      {children}
    </TranscriptMenu>
  )
}