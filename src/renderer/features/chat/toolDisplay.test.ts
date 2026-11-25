import { Plug, Terminal, Waypoints, Wrench, FileText } from 'lucide-react'
import { describe, expect, it } from 'vitest'

import { isLinkableFilePath } from '../../lib/linkify'
import { resolveToolDisplay, toolRowLabel } from './toolDisplay'

describe('resolveToolDisplay tool commands (omp 19)', () => {
  it('Given a bash call whose first word is a rare tool, Then it is that tool\'s row', () => {
    const display = resolveToolDisplay('bash', 'lsp --help')
    expect(display).toMatchObject({ key: 'xd:lsp', entryTool: 'lsp', rawId: 'bash lsp' })
    expect(display.icon).toBe(Waypoints)
  })

  it('Given an MCP tool command, Then it has the Plug icon', () => {
    expect(resolveToolDisplay('bash', 'mcp__srv__do').icon).toBe(Plug)
  })

  it('Given leading env assignments, Then the command word after them names the tool', () => {
    expect(resolveToolDisplay('bash', 'FOO=1 BAR=x lsp diagnostics').entryTool).toBe('lsp')
  })

  it('Given an MCP tool command, Then it keeps its mcp__ name', () => {
    expect(resolveToolDisplay('bash', 'mcp__srv__do --x 1').entryTool).toBe('mcp__srv__do')
  })

  it('Given a plain shell command, Then it stays a bash row', () => {
    const display = resolveToolDisplay('bash', 'ls -la')
    expect(display).toMatchObject({ key: 'bash', entryTool: 'bash', rawId: 'bash' })
    expect(display.icon).toBe(Terminal)
  })

  it.each([
    'ast_edit', 'ast_grep', 'checkpoint', 'debug', 'github', 'lsp', 'memory_edit', 'propose',
    'recall', 'reflect', 'reject', 'resolve', 'retain', 'rewind', 'security_scan'
  ])('Given a bash call to the mounted tool %s, Then it is that tool\'s row', (name) => {
    expect(resolveToolDisplay('bash', `${name} --x 1`)).toMatchObject({ key: `xd:${name}`, entryTool: name, rawId: `bash ${name}` })
  })

  it.each([
    'lsp a | head',
    'lsp x; rm y',
    'lsp x && y',
    'lsp x &',
    'lsp x\nrm y',
    'lsp `rm y`',
    'lsp $(rm y)',
    'FOO=1 lsp x | head',
    'echo x; lsp',
    'FOO=1',
    'FOO=1; lsp x'
  ])('Given the compound or non-tool command %j, Then it stays a bash row', (command) => {
    expect(resolveToolDisplay('bash', command)).toMatchObject({ key: 'bash', entryTool: 'bash', rawId: 'bash' })
  })

  it('Given an unknown first word or a tool name only later in the line, Then it stays a bash row', () => {
    expect(resolveToolDisplay('bash', 'frobnicate --help').key).toBe('bash')
    expect(resolveToolDisplay('bash', 'echo lsp').key).toBe('bash')
    expect(resolveToolDisplay('bash', 'lsp_not_a_tool x').key).toBe('bash')
    expect(resolveToolDisplay('bash', '').key).toBe('bash')
    expect(resolveToolDisplay('bash', undefined).key).toBe('bash')
    expect(resolveToolDisplay('bash', 'toString').key).toBe('bash')
  })

  it('Given the same name in a non-bash tool, Then it is not a tool command', () => {
    expect(resolveToolDisplay('grep', 'lsp').key).toBe('grep')
  })

  it('Given a tool command, Then its label is the tool verb, not "Ran"', () => {
    expect(toolRowLabel('bash', 'lsp hover', undefined, 'done')).toBe('Queried code')
  })
})

describe('resolveToolDisplay xd:// and help:// (omp 18.x and doc reads)', () => {
  it('Given write xd://<tool>, Then it still resolves to that tool and shares the key of the tool command', () => {
    const written = resolveToolDisplay('write', 'xd://lsp')
    expect(written).toMatchObject({ key: 'xd:lsp', entryTool: 'lsp', rawId: 'write xd://lsp' })
    expect(written.key).toBe(resolveToolDisplay('bash', 'lsp x').key)
  })

  it('Given write xd:// with an unknown tool, Then it takes the Wrench icon', () => {
    expect(resolveToolDisplay('write', 'xd://nothing').icon).toBe(Wrench)
  })

  it.each(['help://lsp/hover', 'xd://lsp/hover'])('Given read %s, Then it stays a read row and never a file link', (target) => {
    const display = resolveToolDisplay('read', target)
    expect(display).toMatchObject({ key: 'read', entryTool: 'read' })
    expect(display.icon).toBe(FileText)
    expect(isLinkableFilePath(target)).toBe(false)
  })
})
