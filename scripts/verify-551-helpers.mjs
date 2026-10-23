// Shared helpers for `verify-551-presets.mjs` (#806 file-size ratchet: the gate-round-2 fixes
// pushed the main script past its own 600-line soft cap; this is a pure-logic, behaviour-
// preserving extraction, the same pattern this story already used for `mermaidThemeData.ts` and
// `src-tauri/src/store/theme_id.rs`). Covers issue #551's own gate round 1 items 10 and 12:
// a real OKLab hue/lightness distance check (not a naive string-inequality check) and a CSS
// custom property's own raw cascaded value, read before trusting any `var()`-resolved colour.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveCssVarColor } from './verify-tauri-cdp.mjs';
import { parseComputedColorToEntry } from './contrast-math.mjs';

// ---- Item 12: real OKLab hue/lightness distance, not string inequality --------------------

/** Linear sRGB -> OKLab, the published inverse of `contrast-math.mjs`'s own `oklabToLinearSrgb`
 * (same matrices, Bjorn Ottosson). A reverse conversion only a live-check that must classify a
 * REAL rendered colour's hue/lightness needs, not a general contrast primitive every other
 * script shares. */
export function linearSrgbToOklab([r, g, b]) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  };
}

export function oklabHueDegrees({ a, b }) {
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

export function hueDistanceDegrees(h1, h2) {
  const diff = Math.abs(h1 - h2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/** Real hue/lightness-distance check between two parsed colour strings (from a REAL
 * `getComputedStyle()` read), replacing a naive `colorA === colorB` string-inequality check
 * (gate round 1, item 12) -- two distinct hex strings can still be perceptually indistinguishable
 * (near-identical hue and lightness), and a naive equality check cannot tell them apart. */
export function describeHueLightness(rawColor) {
  const entry = parseComputedColorToEntry(rawColor);
  if (!entry) return null;
  const { L, a, b } = linearSrgbToOklab(entry.linear);
  return { L, hue: oklabHueDegrees({ a, b }), raw: rawColor };
}

// ---- Item 10: a missing CSS custom property must fail loudly, not silently resolve via
// inheritance/initial-value fallback (`var(--missing)` is invalid-at-computed-value-time, which
// most properties resolve to their OWN initial/inherited value, not an error) ------------------

/** Reads the custom property's own raw cascaded value directly off `<html>` -- empty/missing
 * means the token itself was never declared for the active theme, independent of whatever a
 * probe element's `var(--name)` reference silently falls back to. */
export async function cssVarRawValue(cdp, varName) {
  const raw = await cdp.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('${varName}').trim()`);
  return raw;
}

/** Resolves a token's REAL computed colour only after confirming the custom property itself is
 * actually declared -- throws (a real failure, not a silent pass) if it is missing. */
export async function requireResolvedCssVarColor(cdp, varName, property = 'color') {
  const raw = await cssVarRawValue(cdp, varName);
  if (!raw) {
    throw new Error(`verify-551: CSS custom property ${varName} is empty/missing on <html> for the active theme -- a var() probe would have silently fallen back to an inherited/initial colour instead of failing.`);
  }
  return resolveCssVarColor(cdp, varName, property);
}

// ---- Gate round 3 item 5: worktree-cleanup path, same convention every `verify-5xx-*.mjs`/
// `verify-9xx-*.mjs` script defines locally. Moved here (not left in the main script) because
// gate round 3's own fixes pushed that file back over the #806 600-line cap. ------------------

export function worktreesDirFor(repoDir) {
  return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
}

/** Ties the exe under test to the actual commit: both new theme ids, literally present only
 * from this story's commits onward, grepped out of the just-built renderer bundle -- a real,
 * cheap proof this build contains #551's code, independent of git log reasoning about timing
 * (same pattern `verify-927-928-quiet-composer.mjs`'s own marker-assertion established). */
export function assertBundleContainsPresetMarkers(repoRoot) {
  const assetsDir = path.join(repoRoot, 'out', 'tauri-web', 'assets');
  let files;
  try {
    files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  } catch (err) {
    throw new Error(`verify-551: could not read built bundle directory ${assetsDir} (${err.message}) -- run 'pnpm tauri build --debug --no-bundle' first.`);
  }
  const found = { 'nordic-frost': false, 'cyber-amber': false };
  for (const file of files) {
    const text = readFileSync(path.join(assetsDir, file), 'utf8');
    if (text.includes('nordic-frost')) found['nordic-frost'] = true;
    if (text.includes('cyber-amber')) found['cyber-amber'] = true;
  }
  const missing = Object.entries(found)
    .filter(([, present]) => !present)
    .map(([id]) => id);
  if (missing.length > 0) {
    throw new Error(`verify-551: built bundle is missing the theme id marker(s) ${missing.join(', ')} -- this exe predates #551, rebuild before running this check.`);
  }
  console.log('verify-551: confirmed both #551 theme id markers (nordic-frost, cyber-amber) are present in the built renderer bundle.');
}
