// Inline copy of `refract-hero.svg` so each facet takes a grey `--watermark-tone-*` (3D shape, no hue).
// Flat paths, no `<defs>` ids, so two instances never collide.
const FACETS: ReadonlyArray<readonly [tone: string, d: string]> = [
  ['3eac9e', 'M101.5 156.5 L137.5 136 L210.5 178 L174.5 198.5 Z'],
  ['1c8f8f', 'M101.5 156.5 L101.5 198.5 L174.5 241 L174.5 198.5 Z'],
  ['199d95', 'M174.5 198.5 L210.5 178 L210.5 219.5 L174.5 241 Z'],
  ['f8a740', 'M301.5 178 L374.5 136 L410.5 156.5 L337.5 198.5 Z'],
  ['d9811c', 'M337.5 198.5 L410.5 156.5 L410.5 198.5 L337.5 241 Z'],
  ['eca231', 'M301.5 178 L337.5 198.5 L337.5 241 L301.5 219.5 Z'],
  ['a877e0', 'M213.5 319.5 L256 295 L298.5 319.5 L256 344 Z'],
  ['7544c9', 'M213.5 319.5 L256 344 L256 429 L213.5 404 Z'],
  ['4b278a', 'M256 344 L298.5 319.5 L298.5 404 L256 429 Z'],
  ['7844cd', 'M195 219 L256 183.5 L317 219 L256 254.5 Z'],
  ['52208e', 'M195 219 L256 254.5 L256 325.5 L195 290 Z'],
  ['52208e', 'M256 254.5 L317 219 L317 290 L256 325.5 Z'],
  ['8041b5', 'M195 219 L256 254.5 L225.5 237 Z'],
  ['4d1f8e', 'M195 254.5 L225.5 237 L225.5 272 L195 290 Z'],
  ['45187a', 'M195 254.5 L195 219 L225.5 237 Z'],
  ['32ac9e', 'M195 290 L225.5 272 L256 325.5 Z'],
  ['32ac9e', 'M256 254.5 L286.5 237 L286.5 272 L256 325.5 Z'],
  ['f09b29', 'M317 219 L286.5 237 L286.5 272 L317 290 Z'],
  ['492484', 'M256 325.5 L286.5 272 L317 290 Z'],
  ['864dd6', 'M256 254.5 L317 219 L286.5 237 Z']
]

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden focusable={false} viewBox="96 122 320 320" className={className}>
      {FACETS.map(([tone, d], i) => (
        <path key={i} d={d} style={{ fill: `var(--watermark-tone-${tone})` }} />
      ))}
    </svg>
  )
}
