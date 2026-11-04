#!/usr/bin/env node
// Audits every theme's key surface, edge and text pairs under simulated display profiles (#553).
// Report-only: exits 0 unless --strict is passed. Thresholds are #550's ladder rule; the model is in display-profiles.mjs.
// `--themes=a,b` and `--profiles=x,y` narrow what is measured (and so what --strict can fail on).

import { PROFILES } from './display-profiles.mjs'
import { PAIRS, STEP, measure } from './display-profile-pairs.mjs'
import { themes } from './theme-tokens.mjs'

const strict = process.argv.includes('--strict')
const listArg = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3).split(',')
const themeFilter = listArg('themes')
const profileFilter = listArg('profiles')
const auditedProfiles = PROFILES.filter((profile) => !profileFilter || profileFilter.includes(profile.id))
const auditedThemes = Object.entries(themes).filter(([themeId]) => !themeFilter || themeFilter.includes(themeId))

const fmt = (pair, value) => (value === null ? 'missing' : pair.kind === STEP ? `${value.toFixed(2)} L*` : `${value.toFixed(2)}:1`)

const offenders = []
const counts = new Map()
for (const [themeId, props] of auditedThemes) {
  for (const pair of PAIRS) {
    const baseline = measure(pair, themeId, props, null)
    for (const profile of auditedProfiles) {
      const shown = measure(pair, themeId, props, profile)
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

console.log(`Display-profile audit: ${auditedThemes.length} themes, ${auditedProfiles.length} profiles, ${PAIRS.length} pairs each.`)
console.log('"also baseline" means the pair already misses its threshold with no profile applied.\n')
for (const o of offenders) {
  const note = o.alsoBaseline ? ' (also baseline)' : ''
  console.log(`${o.themeId.padEnd(20)} ${o.profile.id.padEnd(15)} ${o.pair.name.padEnd(24)} ${fmt(o.pair, o.baseline).padStart(10)} -> ${fmt(o.pair, o.shown).padStart(10)}  min ${o.pair.min}${note}`)
}

console.log('\nOffenders per theme and profile (newly failing under the profile + also baseline):')
for (const [themeId] of auditedThemes) {
  const cells = auditedProfiles.map((profile) => {
    const c = counts.get(`${themeId}|${profile.id}`) ?? { newlyFailing: 0, alsoBaseline: 0 }
    return `${profile.id} ${c.newlyFailing}+${c.alsoBaseline}`
  })
  console.log(`${themeId.padEnd(20)} ${cells.join('   ')}`)
}
console.log('\nOffenders per profile:')
for (const profile of auditedProfiles) {
  const total = offenders.filter((o) => o.profile.id === profile.id)
  console.log(`${profile.id.padEnd(15)} ${total.length} (${total.filter((o) => !o.alsoBaseline).length} newly failing)`)
}
console.log(`\n${offenders.length} offending pair/profile combinations${strict ? '; --strict: failing.' : '; report-only, exit 0 (pass --strict to fail).'}`)
if (strict && offenders.length > 0) process.exit(1)
