import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { THEME_FORMAT_EXAMPLE } from '@/lib/themeFile'
import schema from '../../../shared/theme.schema.json'
import { THEME_SCHEMA_URL } from '../../../shared/themeSchema'

export interface ThemeFormatDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** Called on close; the caller restores focus to the control that opened the dialog. */
  onCloseFocus?(): void
}

const BASE_IDS = schema.properties.base.enum.join(', ')

/** Help page for theme files: an annotated example, the fallback rule, the schema address and where to get a starter file (#1885). */
export function ThemeFormatDialog({ open, onOpenChange, onCloseFocus }: ThemeFormatDialogProps) {
  const doneRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="min-w-0 max-h-[min(640px,calc(100vh-4rem))] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          doneRef.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onCloseFocus?.()
        }}
      >
        <DialogHeader>
          <DialogTitle>Theme file format</DialogTitle>
          <DialogDescription>A theme is a JSON file. Import it from Settings, Appearance.</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0" viewportProps={{ tabIndex: 0, role: 'region', 'aria-label': 'Theme file format' }}>
          <div className="flex min-w-0 flex-col gap-4 p-1 pr-2 text-sm">
            <section className="flex flex-col gap-2">
              <h3 className="text-xs text-muted-foreground">Example</h3>
              <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs" tabIndex={0} aria-label="Example theme file">
                {THEME_FORMAT_EXAMPLE}
              </pre>
              <ul className="flex list-disc flex-col gap-1 pl-4">
                <li><code>$schema</code> is optional. It lets editors such as VS Code suggest token names and flag mistakes.</li>
                <li><code>version</code> is always 1.</li>
                <li><code>name</code> is shown in the theme list, up to 40 characters.</li>
                <li><code>base</code> is the built-in theme to start from: {BASE_IDS}.</li>
                <li><code>tokens</code> holds only the colours you want to change. Any token you leave out falls back to <code>base</code>.</li>
                <li>Colours are hex, <code>transparent</code>, <code>rgb()</code>, <code>hsl()</code> or <code>oklch()</code>.</li>
              </ul>
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="text-xs text-muted-foreground">Schema</h3>
              <p>
                The schema lists every token with its layer and what it colours. Point <code>$schema</code> at it:
              </p>
              <code className="break-all rounded-md bg-muted p-2 text-xs">{THEME_SCHEMA_URL}</code>
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="text-xs text-muted-foreground">Start from a full file</h3>
              <p>Open the menu on any built-in theme in the list and choose Export a copy. It writes every token with its current value, ready to edit.</p>
            </section>
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button ref={doneRef} variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
