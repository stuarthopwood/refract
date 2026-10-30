// Pure-logic helpers extracted from `verify-551-presets.mjs` to keep it under the #806 file-size cap.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveCssVarColor } from './verify-tauri-cdp.mjs';
import { parseComputedColorToEntry } from './contrast-math.mjs';

/** Linear sRGB -> OKLab; the inverse of `contrast-math.mjs`'s `oklabToLinearSrgb`. */
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

/** Hue/lightness of a computed colour; distinct hex strings can still be perceptually identical, so string equality is not enough. */
export function describeHueLightness(rawColor) {
  const entry = parseComputedColorToEntry(rawColor);
  if (!entry) return null;
  const { L, a, b } = linearSrgbToOklab(entry.linear);
  return { L, hue: oklabHueDegrees({ a, b }), raw: rawColor };
}

/** Raw cascaded value of a custom property off `<html>`; a `var()` probe would silently fall back to an inherited/initial value instead. */
export async function cssVarRawValue(cdp, varName) {
  const raw = await cdp.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('${varName}').trim()`);
  return raw;
}

/** Resolves a token's computed colour, throwing if the custom property is undeclared. */
export async function requireResolvedCssVarColor(cdp, varName, property = 'color') {
  const raw = await cssVarRawValue(cdp, varName);
  if (!raw) {
    throw new Error(`verify-551: CSS custom property ${varName} is empty/missing on <html> for the active theme -- a var() probe would have silently fallen back to an inherited/initial colour instead of failing.`);
  }
  return resolveCssVarColor(cdp, varName, property);
}

export function worktreesDirFor(repoDir) {
  return path.join(path.dirname(repoDir), 'pinion-worktrees', path.basename(repoDir));
}

/** Greps the built bundle for both new theme ids, proving the exe contains #551's code. */
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
