// Issue #730 (FR-113): the polite announcement for `useReorderable` moves; also #1950's "opened in the right
// pane". Rendered once beside the list or link; keying on the serial makes a repeated identical message
// announce again. A `span` so it may sit inside inline prose.
export function ReorderAnnouncer({ text, serial }: { text: string; serial: number }) {
  return (
    <span role="status" aria-live="polite" className="sr-only">
      <span key={serial}>{text}</span>
    </span>
  )
}
