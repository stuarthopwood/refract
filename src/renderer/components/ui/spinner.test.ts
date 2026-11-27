import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const RENDERER_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SPINNER_FILE = join('components', 'ui', 'spinner.tsx')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('one spinner (#1848)', () => {
  it('keeps_animate_spin_inside_the_shared_spinner_component', () => {
    const offenders = sourceFiles(RENDERER_ROOT)
      .filter((file) => relative(RENDERER_ROOT, file) !== SPINNER_FILE)
      .filter((file) => readFileSync(file, 'utf8').includes('animate-spin'))
      .map((file) => relative(RENDERER_ROOT, file))
    expect(offenders, 'render <Spinner /> from components/ui/spinner instead of a raw animate-spin').toEqual([])
  })
})
