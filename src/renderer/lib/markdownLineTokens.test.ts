import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ComposerMarkdownMirror, composerMarkdownSegments } from '@/features/chat/composerMarkdownMirror'
import { findFenceRewrite } from './codeSnippetFence'
import { MAX_STYLED_DRAFT_LENGTH, tokenizeMarkdownDraft } from './markdownLineTokens'

// The mirror component reaches the state barrel, which needs a browser `window`.
vi.mock('@/state', () => ({ useSyntaxTheme: () => 'github-dark' }))

/** The draft the composer holds after typing a one-line block: the rewrite applied to it. */
function rewritten(typed: string): string {
  const edit = findFenceRewrite(typed, typed.length)!
  return typed.slice(0, edit.from) + edit.insert + typed.slice(edit.to)
}

describe('spec 050 styling of a rewritten fence', () => {
  const draft = rewritten('```ts const a = 1```')

  it('keeps every character of the draft', () => {
    expect(draft).toBe('```ts\nconst a = 1\n```\n')
    expect(
      tokenizeMarkdownDraft(draft)
        ?.map((seg) => seg.text)
        .join('')
    ).toBe(draft)
  })

  it('styles the fence lines and the body as code', () => {
    const segments = tokenizeMarkdownDraft(draft)!
    expect(segments.filter((seg) => seg.kind === 'code').map((seg) => seg.text.replace(/\n$/, ''))).toContain('const a = 1')
    expect(segments.every((seg) => seg.kind === 'code' || /^\n+$/.test(seg.text))).toBe(true)
  })

  it('is drawn by the mirror layer, the only overlay, with no extra positioned layer', () => {
    const segments = composerMarkdownSegments(draft, true)!
    const markup = renderToStaticMarkup(createElement(ComposerMarkdownMirror, { segments, text: draft, mirrorRef: { current: null } }))
    expect(markup).toContain('data-composer-markdown-mirror')
    expect(markup.match(/data-composer-markdown-mirror/g)).toHaveLength(1)
    expect(markup).toContain('data-md="code"')
  })
})

describe('composerMarkdownSegments', () => {
  it('returns null for a draft starting with a slash', () => {
    expect(composerMarkdownSegments('/run ```ts a```', true)).toBeNull()
    expect(composerMarkdownSegments('  /run ```ts a```', true)).toBeNull()
  })

  it('returns null when styling is off or the draft is too long', () => {
    expect(composerMarkdownSegments('```ts\na\n```', false)).toBeNull()
    expect(tokenizeMarkdownDraft(`\`\`\`\n${'a'.repeat(MAX_STYLED_DRAFT_LENGTH)}`)).toBeNull()
  })
})
