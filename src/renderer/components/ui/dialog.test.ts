import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('./dialog.tsx', import.meta.url)), 'utf8')
const dialogContentBlock = source.slice(source.indexOf('function DialogContent'), source.indexOf('function DialogHeader'))

describe('dialog column (#2322, FR-222)', () => {
  it('lays_dialog_content_in_one_shrinkable_column_so_a_long_line_cannot_widen_it_past_the_panel', () => {
    expect(dialogContentBlock).toContain(' grid ')
    expect(dialogContentBlock).toContain('grid-cols-[minmax(0,1fr)]')
  })

  it('keeps_the_fix_in_the_shared_component_and_not_in_the_theme_format_dialog', () => {
    const themeFormat = readFileSync(
      fileURLToPath(new URL('../../features/settings/ThemeFormatDialog.tsx', import.meta.url)),
      'utf8'
    )
    expect(themeFormat).not.toContain('grid-cols-')
  })
})
