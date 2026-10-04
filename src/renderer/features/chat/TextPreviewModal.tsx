import type { ReactNode } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import type { PendingTextChip } from './attachments'

export interface TextPreviewModalProps {
  chip: PendingTextChip
  trigger: ReactNode
}

/** FR-012, FR-016: the full original pasted text, read-only, selectable, and scrollable.
 * `trigger` is the clickable chip itself (`DialogTrigger asChild`) -- the same strip badge or
 * inline textarea-overlay button that opened it -- so Radix's own default focus handling (same
 * pattern as every other dialog in the app) returns focus there on Esc or an outside click. */
export function TextPreviewModal({ chip, trigger }: TextPreviewModalProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Pasted text ({chip.text.length} characters)</DialogTitle>
        </DialogHeader>
        <pre className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted p-3 text-xs break-words whitespace-pre-wrap">
          {chip.text}
        </pre>
      </DialogContent>
    </Dialog>
  )
}
