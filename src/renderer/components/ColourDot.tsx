// A GitHub label's colour, decorative only: bordered and forced-colour safe, never the sole signal.
// `color` is six hex digits without `#`; anything else renders transparent (untrusted input).
export function ColourDot({ color }: { color: string }) {
  const safe = /^[0-9a-fA-F]{6}$/.test(color) ? `#${color}` : 'transparent'
  return (
    <span
      aria-hidden
      className="size-2.5 shrink-0 rounded-full border border-border [forced-color-adjust:none]"
      style={{ backgroundColor: safe }}
    />
  )
}
