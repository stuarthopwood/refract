import * as React from 'react'
import { disclosureToggleClassName } from '@/features/chat/linkStyles'

export interface InlineDisclosureProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contentId: string
  label: React.ReactNode
  children: React.ReactNode
}

export function InlineDisclosure({ open, onOpenChange, contentId, label, children }: InlineDisclosureProps) {
  const buttonRef = React.useRef<HTMLButtonElement>(null)

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !open) return
      event.stopPropagation()
      onOpenChange(false)
      buttonRef.current?.focus()
    },
    [open, onOpenChange]
  )

  return (
    <div className="space-y-1" onKeyDown={open ? handleKeyDown : undefined}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => onOpenChange(!open)}
        className={disclosureToggleClassName}
      >
        {label}
      </button>
      <div id={contentId} hidden={!open} className="space-y-2">
        {children}
      </div>
    </div>
  )
}
