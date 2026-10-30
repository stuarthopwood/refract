// Display-profile luminance model for the #553 audit. It is a gamma, black-level and gain curve applied to
// relative luminance, not a simulation of a specific panel: it ignores viewing angle, colour shifts,
// local dimming and the panel's real response, so treat results as a hint to look at the screen.

const REFERENCE_GAMMA = 2.2

// gamma: panel gamma against a 2.2 reference (lower lifts darks, higher crushes them).
// lift: added linear light (a raised black level or reflected ambient light).
// crush: linear luminance at or below this renders as pure black.
// gain: overall brightness scale applied before the lift.
export const PROFILES = [
  { id: 'tn-washout', label: 'TN washout', gamma: 1.8, lift: 0.02, crush: 0, gain: 1 },
  { id: 'va-black-crush', label: 'VA black crush', gamma: 2.6, lift: 0, crush: 0.004, gain: 1 },
  { id: 'sunlight-glare', label: 'Sunlight glare', gamma: 2.2, lift: 0.08, crush: 0, gain: 0.92 },
]

export function applyProfile(luminance, profile) {
  const crushed = Math.max(0, (luminance - profile.crush) / (1 - profile.crush))
  const shaped = profile.gain * crushed ** (profile.gamma / REFERENCE_GAMMA)
  return Math.min(1, Math.max(0, profile.lift + shaped))
}

// CIE lightness, a roughly perceptual scale; #550's surface ladder is measured in it.
export function lightness(luminance) {
  return luminance > 216 / 24389 ? 116 * Math.cbrt(luminance) - 16 : (24389 / 27) * luminance
}
