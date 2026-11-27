// The repo has no jsdom: the section is rendered to a string. Its Raw default and the Radix toggle's
// `aria-checked` / group label are what a keyboard and screen-reader user get, since the toggle group
// handles arrow-key roving and announces the checked item itself.
import { createElement, createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BashCommandBody, BashCommandSection, commandViewFrom } from './BashCommandSection'
import type * as PseudoShellModule from './pseudoShell'
import { parsePseudoShell } from './pseudoShell'

// A spy over the real reader: the section must read the command only once Pseudo is asked for.
vi.mock('./pseudoShell', async (importOriginal) => {
  const actual = await importOriginal<typeof PseudoShellModule>()
  return { ...actual, parsePseudoShell: vi.fn(actual.parsePseudoShell) }
})

// The real header and code block pull in the stores and the Shiki highlighter, neither of which
// loads without a browser; the toggle and the view switch under test are this component's own.
vi.mock('./ToolSectionBlock', () => ({
  SectionHeader: ({ children }: { children?: ReactNode }) => h('div', null, children),
  CappedCodeBlock: ({ code }: { code: string }) => h('pre', null, code)
}))

const html = (code: string) =>
  renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(BashCommandSection, { section: { label: 'command', lang: 'bash', code, defaultView: 'source' } }))
  )

describe('BashCommandSection', () => {
  it('offers Raw and Pseudo in a labelled group with Raw selected by default', () => {
    const out = html('cd src && git diff | head -n 40 > out.txt')
    expect(out).toContain('aria-label="command view"')
    expect(out).toMatch(/aria-checked="true"[^>]*>Raw</)
    expect(out).toMatch(/aria-checked="false"[^>]*>Pseudo</)
  })

  it('shows the command text, not the steps, while Raw is selected', () => {
    const out = html('cd src && git diff | head -n 40 > out.txt')
    expect(out).toContain('out.txt')
    expect(out).not.toContain('Command steps')
    expect(out).not.toContain("Can't show this command as steps")
  })

  it('shows each step of the Pseudo view as its own list item', () => {
    const out = renderToStaticMarkup(createElement(BashCommandBody, { view: 'pseudo', code: 'cd src && git diff | head -n 40 > out.txt', lang: 'bash' }))
    expect(out).toContain('aria-label="Command steps"')
    expect(out.match(/<li /g)).toHaveLength(5)
    for (const step of ['cd(&quot;src&quot;)', 'git(&quot;diff&quot;)', 'head(&quot;-n&quot;, &quot;40&quot;)', 'stdout &gt; &quot;out.txt&quot;']) expect(out).toContain(step)
  })

  it('falls back to the Raw text with the note when the parser rejects the command', () => {
    const out = renderToStaticMarkup(createElement(BashCommandBody, { view: 'pseudo', code: 'echo $(date)', lang: 'bash' }))
    expect(out).toContain("Can&#x27;t show this command as steps.")
    expect(out).toContain('echo $(date)')
    expect(out).not.toContain('Command steps')
  })

  it('announces the refusal note as a status so a screen reader hears why the steps are missing', () => {
    const out = renderToStaticMarkup(createElement(BashCommandBody, { view: 'pseudo', code: 'echo $(date)', lang: 'bash' }))
    expect(out).toMatch(/<p [^>]*role="status"[^>]*>Can&#x27;t show this command as steps\./)
  })

  it('says under the steps that shell expansions are not evaluated', () => {
    const out = renderToStaticMarkup(createElement(BashCommandBody, { view: 'pseudo', code: 'echo $HOME *.ts', lang: 'bash' }))
    expect(out).toContain('Shell expansions aren&#x27;t evaluated.')
  })

  it('does not show the expansion caption in the Raw view', () => {
    const out = renderToStaticMarkup(createElement(BashCommandBody, { view: 'raw', code: 'echo $HOME', lang: 'bash' }))
    expect(out).not.toContain('expansions')
  })

  it('gives a nested step a screen-reader-only level prefix and leaves top-level steps without one', () => {
    const nested = renderToStaticMarkup(createElement(BashCommandBody, { view: 'pseudo', code: '(cd a; ls) | wc -l', lang: 'bash' }))
    expect(nested.match(/<span class="sr-only">Level 2: <\/span>/g)).toHaveLength(2)
    const flat = renderToStaticMarkup(createElement(BashCommandBody, { view: 'pseudo', code: 'cd a; ls', lang: 'bash' }))
    expect(flat).not.toContain('Level')
  })

  describe('reading the command', () => {
    beforeEach(() => {
      vi.mocked(parsePseudoShell).mockClear()
    })

    it('does not read the command while Raw is selected', () => {
      renderToStaticMarkup(createElement(BashCommandBody, { view: 'raw', code: 'ls', lang: 'bash' }))
      expect(parsePseudoShell).not.toHaveBeenCalled()
    })

    it('reads the command when Pseudo is selected', () => {
      renderToStaticMarkup(createElement(BashCommandBody, { view: 'pseudo', code: 'ls', lang: 'bash' }))
      expect(parsePseudoShell).toHaveBeenCalledTimes(1)
    })
  })
})

describe('commandViewFrom', () => {
  it('accepts the two views', () => {
    expect(commandViewFrom('raw')).toBe('raw')
    expect(commandViewFrom('pseudo')).toBe('pseudo')
  })

  it('ignores the empty value a single toggle sends when the selected item is pressed again, and anything unknown', () => {
    expect(commandViewFrom('')).toBeUndefined()
    expect(commandViewFrom('steps')).toBeUndefined()
  })
})
