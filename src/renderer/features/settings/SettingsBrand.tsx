// The Settings header's brand mark (#450): the decorative Refract icon plus the wordmark text,
// the same pair the Session list header shows. Not focusable; the back button keeps the focus order.
import refractHero from '@/assets/brand/refract-hero.svg'

export function SettingsBrand() {
  return (
    <span className="flex items-center gap-2">
      <img src={refractHero} alt="" aria-hidden className="size-4 shrink-0" />
      <span className="text-sm font-medium">Refract</span>
    </span>
  )
}
