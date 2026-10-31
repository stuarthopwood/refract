// Applies a custom theme's tokens as inline custom properties; never builds CSS text (#458).
import tokenList from '../../shared/theme-tokens.json';

export const THEME_TOKENS: readonly string[] = tokenList.tokens;
const ALLOWED = new Set<string>(THEME_TOKENS);
// Defence in depth: Rust already enforces this grammar before a file reaches the renderer.
const COLOUR = /^(#[0-9a-f]{3,8}|transparent|(rgba?|hsla?|oklch)\([0-9a-z.%,\s/+-]*\))$/i;

/** Sets each allowlisted, well-formed token on `el`; returns the property names it set. */
export function applyTokens(el: HTMLElement, tokens: Record<string, string>): string[] {
  const set: string[] = [];
  for (const [token, value] of Object.entries(tokens)) {
    if (!ALLOWED.has(token) || !COLOUR.test(value)) continue;
    el.style.setProperty(`--${token}`, value);
    set.push(`--${token}`);
  }
  return set;
}

export function clearTokens(el: HTMLElement, props: readonly string[]): void {
  for (const prop of props) el.style.removeProperty(prop);
}

/** A complete starter file for `base`: every allowlisted token resolved to a colour the file grammar accepts. */
export function buildStarterJson(name: string, base: string): string {
  const probe = document.createElement('div');
  probe.className = `dark theme-${base}`;
  probe.style.cssText = 'position:fixed;left:-9999px;visibility:hidden';
  document.body.appendChild(probe);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tokens: Record<string, string> = {};
  try {
    for (const token of THEME_TOKENS) {
      probe.style.color = `var(--${token})`;
      if (!ctx) break;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = getComputedStyle(probe).color;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      const hex = Array.from(d, (v) => v.toString(16).padStart(2, '0')).join('');
      tokens[token] = `#${hex}`;
    }
  } finally {
    probe.remove();
  }
  return JSON.stringify({ version: 1, name, base, tokens }, null, 2) + '\n';
}
