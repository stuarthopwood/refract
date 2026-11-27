// One answer to "should this motion be skipped?" for JS-driven motion (#566). CSS handles the same two
// signals itself: the OS `prefers-reduced-motion` media query and the root `data-reduce-motion="on"`
// attribute that settings-store sets from Settings > Appearance > Reduce motion.
const OS_QUERY = '(prefers-reduced-motion: reduce)'

export function osPrefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia(OS_QUERY).matches
}

export function appReducesMotion(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.reduceMotion === 'on'
}

export function isMotionReduced(): boolean {
  return osPrefersReducedMotion() || appReducesMotion()
}
