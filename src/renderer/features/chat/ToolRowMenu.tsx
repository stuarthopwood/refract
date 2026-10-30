import * as React from 'react'
import type { TranscriptItem } from '../../../shared/model'
import { ContextMenuSeparator } from '@/components/ui/context-menu'
import { actionMenuItem } from '@/features/palette/menuItems'
import { commandRowText } from './formatToolCommand'
import { copyLinkText } from './linkClipboard'
import { TranscriptMenu } from './TranscriptMenu'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

interface ToolRowMenuProps {
  /** The single tool call this row stands for; a multi-call group passes none and gets no menu. */
  item: ToolItem | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

/** The tool row's context menu (#471): copy the command and output, and expand or collapse the row; none while it runs. */
export function ToolRowMenu({ item, open, onOpenChange, children }: ToolRowMenuProps) {
  const command = item ? commandRowText(item) : ''
  const output = item?.status === 'running' ? '' : (item?.output ?? '')
  return (
    <TranscriptMenu
      disabled={!item || item.status === 'running'}
      items={
        <>
          {command !== '' &&
            actionMenuItem('transcript.copy-command', { onSelect: () => void copyLinkText(command, 'Command copied', 'Nothing to copy: the command only contains hidden characters') })}
          {output !== '' &&
            actionMenuItem('transcript.copy-output', { onSelect: () => void copyLinkText(output, 'Output copied', 'Nothing to copy: the output only contains hidden characters') })}
          {(command !== '' || output !== '') && <ContextMenuSeparator />}
          {actionMenuItem(open ? 'transcript.collapse' : 'transcript.expand', { onSelect: () => onOpenChange(!open) })}
        </>
      }
    >
      {children}
    </TranscriptMenu>
  )
}
