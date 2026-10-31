// Contrast warnings for a custom theme (#458): resolve each pair through a probe element so base fallbacks and derived tokens are honoured.
import type { CustomTheme } from '../../shared/ipc-themes';
import { applyTokens } from './themeTokens';

export interface ContrastWarning { fg: string; bg: string; ratio: number; min: number; label: string }

const PAIRS: ReadonlyArray<readonly [string, string, number, string]> = [
  ['foreground', 'background', 4.5, 'Text on Background'],
  ['muted-foreground', 'background', 4.5, 'Muted text on Background'],
  ['chat-foreground', 'background', 4.5, 'Chat text on Background'],
  ['card-foreground', 'card', 4.5, 'Text on Card'],
  ['popover-foreground', 'popover', 4.5, 'Text on Popover'],
  ['primary-foreground', 'primary', 4.5, 'Text on Primary buttons'],
  ['secondary-foreground', 'secondary', 4.5, 'Text on Secondary buttons'],
  ['accent-foreground', 'accent', 4.5, 'Text on Accent'],
  ['destructive-foreground', 'destructive', 4.5, 'Text on Destructive buttons'],
  ['chat-user-bubble-fg', 'chat-user-bubble-bg', 4.5, 'Your message text on its bubble'],
  ['foreground', 'sidebar-right', 4.5, 'Text on the side panel'],
  ['ring', 'background', 3, 'Focus ring on Background'],
  ['border', 'background', 3, 'Control edges on Background'],
  ['tool-row-fg', 'background', 4.5, 'Tool row text'],
  ['tool-row-error-fg', 'background', 4.5, 'Tool row error text'],
  ['notice-error-fg', 'background', 4.5, 'Error notice text'],
  ['approval-card-fg', 'approval-card-bg', 4.5, 'Text on Approval card'],
  ['composer-control-fg', 'background', 4.5, 'Composer control text'],
  ['button-secondary-fg', 'button-secondary-bg', 4.5, 'Text on Secondary buttons'],
  ['button-destructive-fg', 'button-destructive-bg', 4.5, 'Text on Destructive buttons'],
  ['status-bar-fg', 'status-bar-bg', 4.5, 'Status bar text'],
  ['tooltip-fg', 'tooltip-bg', 4.5, 'Tooltip text'],
  ['session-row-selected-fg', 'session-row-selected-bg', 4.5, 'Selected session row text']
]

type Rgba = [number, number, number, number]

function canvasContext(): CanvasRenderingContext2D | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  return canvas.getContext('2d', { willReadFrequently: true });
}

function toRgba(ctx: CanvasRenderingContext2D, colour: string): Rgba | null {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 0) / 255];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  const mix = (i: 0 | 1 | 2) => top[i] * a + bottom[i] * (1 - a);
  return [mix(0), mix(1), mix(2), 1];
}

export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const l1 = luminance(over(fg, bg));
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Warnings for `theme`, measured in a detached probe so the live UI never flickers. */
export function checkThemeContrast(theme: Pick<CustomTheme, 'base' | 'tokens'>): ContrastWarning[] {
  const ctx = canvasContext();
  if (!ctx) return [];
  const probe = document.createElement('div');
  probe.className = `dark theme-${theme.base}`;
  probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;visibility:hidden';
  applyTokens(probe, theme.tokens);
  document.body.appendChild(probe);
  try {
    const read = (token: string): Rgba | null => {
      probe.style.color = `var(--${token})`;
      return toRgba(ctx, getComputedStyle(probe).color);
    };
    const solid = read('background') ?? [0, 0, 0, 1];
    const warnings: ContrastWarning[] = [];
    for (const [fgToken, bgToken, min, label] of PAIRS) {
      const fg = read(fgToken);
      const bgRaw = read(bgToken);
      if (!fg || !bgRaw) continue;
      const ratio = contrastRatio(fg, over(bgRaw, solid));
      if (ratio < min) warnings.push({ fg: fgToken, bg: bgToken, ratio, min, label });
    }
    return warnings;
  } finally {
    probe.remove();
  }
}

export function describeWarning(w: ContrastWarning): string {
  return `${w.label}: ${w.ratio.toFixed(1)}:1 (needs ${w.min}:1)`;
}
