// Issue #730 (FR-113): the polite announcement for `useReorderable` moves. Rendered once beside
// the list; keying on the serial makes a repeated identical message announce again.
export function ReorderAnnouncer({ text, serial }: { text: string; serial: number }) {
  return (
    <div role="status" aria-live="polite" className="sr-only">
      <span key={serial}>{text}</span>
    </div>
  )
}
