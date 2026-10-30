#!/usr/bin/env node
// Audits every theme's key surface, edge and text pairs under simulated display profiles (#553).
// Report-only: exits 0 unless --strict is passed. Thresholds are #550's ladder rule; the model is in display-profiles.mjs.

import { contrastRatio, relativeLuminance, resolvedLinear } from './contrast-math.mjs'
import { PROFILES, applyProfile, lightness } from './display-profiles.mjs'
import { themes } from './theme-tokens.mjs'

const STEP = 'step'
const RATIO = 'ratio'

// A step pair needs `a` at least `min` L* above `b`; a ratio pair needs a WCAG contrast of at least `min`.
// A translucent `a` is composited over `b`, the surface it sits on.
const PAIRS = [
  { name: 'card vs canvas', kind: STEP, a: 'card', b: 'background', min: 5 },
  { name: 'popover vs canvas', kind: STEP, a: 'popover', b: 'background', min: 5 },
  { name: 'sidebar vs canvas', kind: STEP, a: 'sidebar', b: 'background', min: 2.3 },
  { name: 'divider vs canvas', kind: RATIO, a: 'divider', b: 'background', min: 1.5 },
  { name: 'divider vs card', kind: RATIO, a: 'divider', b: 'card', min: 1.5 },
  { name: 'control edge vs canvas', kind: RATIO, a: 'border', b: 'background', min: 3 },
  { name: 'control edge vs card', kind: RATIO, a: 'border', b: 'card', min: 3 },
  { name: 'input edge vs canvas', kind: RATIO, a: 'input', b: 'background', min: 3 },
  { name: 'input edge vs card', kind: RATIO, a: 'input', b: 'card', min: 3 },
  { name: 'muted text vs canvas', kind: RATIO, a: 'muted-foreground', b: 'background', min: 4.5 },
  { name: 'muted text vs card', kind: RATIO, a: 'muted-foreground', b: 'card', min: 4.5 },
]

const strict = process.argv.includes('--strict')

function measure(pair, props, profile) {
  const a = props[pair.a]
  const b = props[pair.b]
  if (!a || !b) return null
  let lumA = relativeLuminance(resolvedLinear(a, b))
  // `b` is opaque, so resolvedLinear returns it unchanged; the second argument is only a placeholder backdrop.
  let lumB = relativeLuminance(resolvedLinear(b, b))
  if (profile) {
    lumA = applyProfile(lumA, profile)
    lumB = applyProfile(lumB, profile)
  }
  return pair.kind === STEP ? lightness(lumA) - lightness(lumB) : contrastRatio(lumA, lumB)
}

const fmt = (pair, value) => (value === null ? 'missing' : pair.kind === STEP ? `${value.toFixed(2)} L*` : `${value.toFixed(2)}:1`)

const offenders = []
const counts = new Map()
for (const [themeId, props] of Object.entries(themes)) {
  for (const pair of PAIRS) {
    const baseline = measure(pair, props, null)
    for (const profile of PROFILES) {
      const shown = measure(pair, props, profile)
      if (shown !== null && shown >= pair.min - 1e-9) continue
      const key = `${themeId}|${profile.id}`
      const entry = counts.get(key) ?? { newlyFailing: 0, alsoBaseline: 0 }
      const alsoBaseline = baseline === null || baseline < pair.min - 1e-9
      if (alsoBaseline) entry.alsoBaseline++
      else entry.newlyFailing++
      counts.set(key, entry)
      offenders.push({ themeId, profile, pair, baseline, shown, alsoBaseline })
    }
  }
}

console.log(`Display-profile audit: ${Object.keys(themes).length} themes, ${PROFILES.length} profiles, ${PAIRS.length} pairs each.`)
console.log('"also baseline" means the pair already misses its threshold with no profile applied.\n')
for (const o of offenders) {
  const note = o.alsoBaseline ? ' (also baseline)' : ''
  console.log(`${o.themeId.padEnd(20)} ${o.profile.id.padEnd(15)} ${o.pair.name.padEnd(24)} ${fmt(o.pair, o.baseline).padStart(10)} -> ${fmt(o.pair, o.shown).padStart(10)}  min ${o.pair.min}${note}`)
}

console.log('\nOffenders per theme and profile (newly failing under the profile + also baseline):')
for (const themeId of Object.keys(themes)) {
  const cells = PROFILES.map((profile) => {
    const c = counts.get(`${themeId}|${profile.id}`) ?? { newlyFailing: 0, alsoBaseline: 0 }
    return `${profile.id} ${c.newlyFailing}+${c.alsoBaseline}`
  })
  console.log(`${themeId.padEnd(20)} ${cells.join('   ')}`)
}
console.log('\nOffenders per profile:')
for (const profile of PROFILES) {
  const total = offenders.filter((o) => o.profile.id === profile.id)
  console.log(`${profile.id.padEnd(15)} ${total.length} (${total.filter((o) => !o.alsoBaseline).length} newly failing)`)
}
console.log(`\n${offenders.length} offending pair/profile combinations${strict ? '; --strict: failing.' : '; report-only, exit 0 (pass --strict to fail).'}`)
if (strict && offenders.length > 0) process.exit(1)
