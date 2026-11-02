import * as React from 'react'
import { Markdown } from '@/features/chat/Markdown'
import { ComposerBox, ComposerField, ComposerFooter, ComposerTextarea } from '@/components/ComposerBox'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { MARKDOWN_ACTIONS, MarkdownToolbar, type MarkdownAction } from './MarkdownToolbar'
import type { EditState } from './markdownFormat'

export interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  // Ctrl+Enter (Cmd+Enter on macOS).
  onSubmit?: () => void
  // Esc in the Write field.
  onCancel?: () => void
  size?: 'full' | 'compact'
  placeholder?: string
  ariaLabel: string
  disabled?: boolean
  autoFocus?: boolean
  // Buttons rendered under the field.
  footer?: React.ReactNode
  textareaRef?: React.Ref<HTMLTextAreaElement>
  className?: string
  // Extra props for the Preview's Markdown (githubStyle, resolveImage); keep the reference stable.
  previewProps?: Omit<React.ComponentProps<typeof Markdown>, 'text' | 'id'>
}

type Mode = 'write' | 'preview'

const SHORTCUT_ACTIONS: Record<string, string> = { b: 'bold', i: 'italic', k: 'link' }

export function MarkdownEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  size = 'full',
  placeholder,
  ariaLabel,
  disabled,
  autoFocus,
  footer,
  textareaRef,
  className,
  previewProps
}: MarkdownEditorProps) {
  const [mode, setMode] = React.useState<Mode>('write')
  const innerRef = React.useRef<HTMLTextAreaElement | null>(null)
  const pendingSelection = React.useRef<{ start: number; end: number } | null>(null)
  const previewId = React.useId()
  const compact = size === 'compact'

  const setRefs = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      innerRef.current = node
      if (typeof textareaRef === 'function') textareaRef(node)
      else if (textareaRef) (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node
    },
    [textareaRef]
  )

  // Restores the selection once the controlled value has re-rendered.
  React.useLayoutEffect(() => {
    const pending = pendingSelection.current
    const textarea = innerRef.current
    if (!pending || !textarea) return
    pendingSelection.current = null
    textarea.focus()
    textarea.setSelectionRange(pending.start, pending.end)
  }, [value])

  const runAction = (action: MarkdownAction) => {
    const textarea = innerRef.current
    if (!textarea || disabled) return
    const state: EditState = { value, selectionStart: textarea.selectionStart, selectionEnd: textarea.selectionEnd }
    const result = action.apply(state)
    if (result.value === value) {
      pendingSelection.current = null
      textarea.setSelectionRange(result.selectionStart, result.selectionEnd)
      return
    }
    pendingSelection.current = { start: result.selectionStart, end: result.selectionEnd }
    onChange(result.value)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const modifier = event.ctrlKey || event.metaKey
    if (modifier && event.key === 'Enter') {
      if (onSubmit) {
        event.preventDefault()
        onSubmit()
      }
      return
    }
    if (event.key === 'Escape' && onCancel) {
      if (event.defaultPrevented || disabled) return
      event.preventDefault()
      event.stopPropagation()
      onCancel()
      return
    }
    if (modifier && !event.altKey && !event.shiftKey) {
      const actionId = SHORTCUT_ACTIONS[event.key.toLowerCase()]
      const action = actionId ? MARKDOWN_ACTIONS.find((candidate) => candidate.id === actionId) : undefined
      if (action) {
        event.preventDefault()
        runAction(action)
      }
    }
  }

  const minHeight = compact ? 'min-h-16' : 'min-h-32'

  return (
    <ComposerBox onKeyDown={handleKeyDown} className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-2">
        <ToggleGroup
          type="single"
          size="sm"
          aria-label="Editor mode"
          value={mode}
          onValueChange={(next) => {
            if (next === 'write' || next === 'preview') setMode(next)
          }}
        >
          <ToggleGroupItem value="write">
            Write
          </ToggleGroupItem>
          <ToggleGroupItem value="preview">
            Preview
          </ToggleGroupItem>
        </ToggleGroup>
        {mode === 'write' && <MarkdownToolbar onAction={runAction} disabled={disabled} />}
      </div>
      {mode === 'write' ? (
        <ComposerField>
          <ComposerTextarea
            ref={setRefs}
            actionCount={0}
            aria-label={ariaLabel}
            placeholder={placeholder}
            value={value}
            readOnly={disabled}
            aria-busy={disabled || undefined}
            autoFocus={autoFocus}
            onChange={(event) => onChange(event.target.value)}
            className={cn(minHeight, 'max-h-96 resize-y font-code')}
          />
        </ComposerField>
      ) : (
        <div className={cn('max-h-96 overflow-y-auto px-2 py-2', minHeight)} aria-label={`${ariaLabel} preview`} role="region" tabIndex={0}>
          {value.trim() ? (
            <Markdown text={value} id={previewId} {...previewProps} />
          ) : (
            <p className="text-sm text-muted-foreground">Nothing to preview</p>
          )}
        </div>
      )}
      {footer && <ComposerFooter className="justify-end">{footer}</ComposerFooter>}
    </ComposerBox>
  )
}
