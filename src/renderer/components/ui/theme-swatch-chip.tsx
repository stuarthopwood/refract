import { cn } from '@/lib/utils'

interface ThemeSwatchChipProps {
  /** The theme's own `--background` colour (left half). */
  swatch: string
  /** The theme's own `--primary` colour (right half). */
  swatchPrimary: string
  className?: string
}

// #1070 (ADR 0003): the 20x12 two-colour theme preview shared by the Profile > Theme menu and
// Settings > Appearance. Decorative (the theme name is the identifier) and never round, so it is not
// mistaken for the row's own radio mark. `forced-color-adjust-none` keeps the two real theme colours
// in Windows High Contrast, where the border switches to `CanvasText`.
export function ThemeSwatchChip({ swatch, swatchPrimary, className }: ThemeSwatchChipProps) {
  return (
    <span
      aria-hidden
      className={cn('h-3 w-5 shrink-0 rounded-sm border border-border forced-color-adjust-none forced-colors:border-[CanvasText]', className)}
      style={{ background: `linear-gradient(90deg, ${swatch} 50%, ${swatchPrimary} 50%)` }}
    />
  )
}
