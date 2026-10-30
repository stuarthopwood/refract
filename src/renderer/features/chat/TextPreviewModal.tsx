import { useRef, type ReactNode, type RefObject } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { CopyButton } from '@/components/ui/copy-button'
import type { PendingTextChip } from './attachments'

export interface TextPreviewModalProps {
  chip: PendingTextChip
  trigger: ReactNode
  restoreFocusTo?: RefObject<HTMLElement | null>
}

/** `trigger` is the clickable chip itself. */
export function TextPreviewModal({ chip, trigger, restoreFocusTo }: TextPreviewModalProps) {
  // `onOpenAutoFocus` below redirects initial focus to the read-only text region instead.
  const textRegionRef = useRef<HTMLPreElement>(null)

  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        className="sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          textRegionRef.current?.focus()
        }}
        onCloseAutoFocus={
          restoreFocusTo
            ? (event) => {
                event.preventDefault()
                restoreFocusTo.current?.focus()
              }
            : undefined
        }
      >
        <DialogHeader>
          {/* `pr-8` keeps the dialog's absolute Close button off the trailing Copy button (#524). */}
          <div className="flex items-center justify-between gap-2 pr-8">
            <DialogTitle>Pasted text ({chip.text.length} characters)</DialogTitle>
            <CopyButton getText={() => chip.text} label="Copy pasted text" announcement="Pasted text copied" />
          </div>
        </DialogHeader>
        <pre
          ref={textRegionRef}
          tabIndex={0}
          role="region"
          aria-label="Pasted text"
          className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted p-4 text-xs break-words whitespace-pre-wrap outline-none focus-visible:outline-hidden focus-visible:outline-offset-[-2px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {chip.text}
        </pre>
      </DialogContent>
    </Dialog>
  )
}
