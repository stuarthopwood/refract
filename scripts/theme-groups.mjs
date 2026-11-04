// Theme ids the contrast scripts scope rows to, so a new preset is added in one place (#1590).

/** Dark standard-contrast presets: no solid composer fill, 4.5:1 text floor. */
export const DARK_STANDARD_THEMES = ['dark', 'obsidian', 'nordic-frost', 'cyber-amber', 'lagoon', 'amethyst', 'hearth']

/** Light standard-contrast presets: same tokens as the dark ones, but a pale surface cannot reach the dark 1.4:1 chip separation. */
export const LIGHT_STANDARD_THEMES = ['light', 'light-warm-paper']

/** Every standard-contrast preset. */
export const STANDARD_THEMES = [...DARK_STANDARD_THEMES, ...LIGHT_STANDARD_THEMES]

/** High-contrast presets: solid composer fill, 7:1 text floor. */
export const HIGH_CONTRAST_THEMES = ['dark-high-contrast', 'light-high-contrast']
