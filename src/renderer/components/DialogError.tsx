import { cn } from '@/lib/utils'
import { InlineStatus } from '@/components/InlineStatus'

/** A dialog's failure line: always mounted so setting `message` is announced, and visually empty (screen-reader-only) while there is none. */
export function DialogError({ message, id }: { message: string | null | undefined; id?: string }) {
  return (
    <InlineStatus tone="error" id={id} className={cn('p-0', !message && 'sr-only')}>
      {message ?? ''}
    </InlineStatus>
  )
}
