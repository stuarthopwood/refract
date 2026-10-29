import * as React from 'react'
import { Toolbar as ToolbarPrimitive } from 'radix-ui'
import { Bold, Code, Heading, Italic, Link, List, ListChecks, ListOrdered, Quote, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  applyBold,
  applyBulletedList,
  applyCode,
  applyHeading,
  applyItalic,
  applyLink,
  applyNumberedList,
  applyQuote,
  applyTaskList,
  type EditState
} from './markdownFormat'

export interface MarkdownAction {
  id: string
  label: string
  Icon: LucideIcon
  shortcut?: string
  apply: (state: EditState) => EditState
}

export const MARKDOWN_ACTIONS: readonly MarkdownAction[] = [
  { id: 'heading', label: 'Heading', Icon: Heading, apply: applyHeading },
  { id: 'bold', label: 'Bold', Icon: Bold, shortcut: 'Ctrl+B', apply: applyBold },
  { id: 'italic', label: 'Italic', Icon: Italic, shortcut: 'Ctrl+I', apply: applyItalic },
  { id: 'quote', label: 'Quote', Icon: Quote, apply: applyQuote },
  { id: 'code', label: 'Code', Icon: Code, apply: applyCode },
  { id: 'link', label: 'Link', Icon: Link, shortcut: 'Ctrl+K', apply: applyLink },
  { id: 'bulleted-list', label: 'Bulleted list', Icon: List, apply: applyBulletedList },
  { id: 'numbered-list', label: 'Numbered list', Icon: ListOrdered, apply: applyNumberedList },
  { id: 'task-list', label: 'Task list', Icon: ListChecks, apply: applyTaskList }
]

export function MarkdownToolbar({ onAction, disabled }: { onAction: (action: MarkdownAction) => void; disabled?: boolean }) {
  return (
    <ToolbarPrimitive.Root aria-label="Markdown formatting" className="flex items-center gap-0.5">
      {MARKDOWN_ACTIONS.map((action) => (
        <Tooltip key={action.id}>
          <TooltipTrigger asChild>
            <ToolbarPrimitive.Button asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={action.label}
                aria-keyshortcuts={action.shortcut}
                disabled={disabled}
                // Keep the textarea's selection: a mouse press on the button must not blur it.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onAction(action)}
              >
                <action.Icon aria-hidden="true" />
              </Button>
            </ToolbarPrimitive.Button>
          </TooltipTrigger>
          <TooltipContent>
            {action.label}
            {action.shortcut ? <Kbd>{action.shortcut}</Kbd> : null}
          </TooltipContent>
        </Tooltip>
      ))}
    </ToolbarPrimitive.Root>
  )
}
