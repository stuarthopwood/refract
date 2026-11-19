// Spec 124 FR-019, FR-021 (#1888): a mutating panel action tells Rust it is about to change files,
// changes nothing when Rust refuses, and does not wait for the follow-up reload.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PANEL_ACTION_HANDLERS, type PanelActionContext } from './agent-panel-actions'

const calls: string[] = []
const git = vi.hoisted(() => ({
  state: {
    load: vi.fn(),
    stage: vi.fn(),
    unstage: vi.fn(),
    requestShowFile: vi.fn(),
    bySession: {} as Record<string, unknown>
  }
}))

const docs = vi.hoisted(() => ({ openDocument: vi.fn() }))
const explorer = vi.hoisted(() => ({
  state: { loadDirectory: vi.fn(), loadPreview: vi.fn(), toggleExpanded: vi.fn(), setSelectedPath: vi.fn(), bySession: {} as Record<string, unknown> }
}))

vi.mock('@/state', () => ({ useGitChangesStore: { getState: () => git.state }, useFileExplorerStore: { getState: () => explorer.state } }))
vi.mock('../documents/open-document', () => ({ openDocument: docs.openDocument }))

function snapshotWith(group: 'staged' | 'changes', path: string) {
  const groups = { staged: [] as { path: string }[], changes: [] as { path: string }[], untracked: [] as { path: string }[] }
  groups[group].push({ path })
  return { s1: { snapshot: { groups } } }
}

function context(started: () => Promise<boolean>): PanelActionContext {
  return { sessionId: 's1', open: () => calls.push('open'), started }
}

function handler(panel: string, action: string) {
  const found = PANEL_ACTION_HANDLERS[panel]?.[action]
  if (!found) throw new Error(`no handler ${panel}.${action}`)
  return found
}

const stageFile = handler('git-changes', 'stage_file')
const unstageFile = handler('git-changes', 'unstage_file')

beforeEach(() => {
  docs.openDocument.mockReset()
  explorer.state.setSelectedPath.mockReset()
  calls.length = 0
  git.state.load.mockReset().mockImplementation(async () => {
    calls.push('load')
  })
  git.state.stage.mockReset().mockImplementation(async () => {
    calls.push('stage')
    return { ok: true, value: undefined }
  })
  git.state.unstage.mockReset().mockImplementation(async () => {
    calls.push('unstage')
    return { ok: true, value: undefined }
  })
  git.state.bySession = snapshotWith('changes', 'a.txt')
})

describe('stage_file', () => {
  it('signals started after the pre-action reload and before it stages, without awaiting the follow-up reload', async () => {
    const started = vi.fn(async () => {
      calls.push('started')
      return true
    })
    const outcome = await stageFile(context(started), { path: 'a.txt' })
    expect(outcome).toEqual({ ok: true, value: { path: 'a.txt', staged: true } })
    expect(calls).toEqual(['load', 'started', 'open', 'stage'])
    expect(git.state.stage).toHaveBeenCalledWith('s1', ['a.txt'], { awaitRefresh: false })
  })

  it('changes nothing and opens nothing when Rust refuses started', async () => {
    const outcome = await stageFile(context(async () => false), { path: 'a.txt' })
    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(git.state.stage).not.toHaveBeenCalled()
    expect(calls).not.toContain('open')
  })

  it.each([
    ['an unsafe path', { path: '../a.txt' }],
    ['a file that is not changed', { path: 'other.txt' }]
  ])('does not signal started for %s', async (_name, input) => {
    const started = vi.fn(async () => true)
    const outcome = await stageFile(context(started), input)
    expect(outcome).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(started).not.toHaveBeenCalled()
  })

  it('does not signal started for a file that is already staged', async () => {
    git.state.bySession = snapshotWith('staged', 'a.txt')
    const started = vi.fn(async () => true)
    expect(await stageFile(context(started), { path: 'a.txt' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(started).not.toHaveBeenCalled()
  })

  it('reports a git failure as action_failed', async () => {
    git.state.stage.mockResolvedValue({ ok: false, error: { code: 'git-failed', message: 'index locked' } })
    expect(await stageFile(context(async () => true), { path: 'a.txt' })).toEqual({ ok: false, code: 'action_failed', message: 'index locked' })
  })
})

describe('unstage_file', () => {
  beforeEach(() => {
    git.state.bySession = snapshotWith('staged', 'a.txt')
  })

  it('signals started before it unstages, without awaiting the follow-up reload', async () => {
    const started = vi.fn(async () => {
      calls.push('started')
      return true
    })
    const outcome = await unstageFile(context(started), { path: 'a.txt' })
    expect(outcome).toEqual({ ok: true, value: { path: 'a.txt', staged: false } })
    expect(calls).toEqual(['load', 'started', 'open', 'unstage'])
    expect(git.state.unstage).toHaveBeenCalledWith('s1', ['a.txt'], { awaitRefresh: false })
  })

  it('changes nothing when Rust refuses started', async () => {
    expect(await unstageFile(context(async () => false), { path: 'a.txt' })).toMatchObject({ ok: false, code: 'action_failed' })
    expect(git.state.unstage).not.toHaveBeenCalled()
  })
})

describe('show_file', () => {
  const showFileAction = handler('git-changes', 'show_file')

  it('opens a diff tab without taking focus and announces it', async () => {
    docs.openDocument.mockReturnValue({ existed: false })
    git.state.bySession = snapshotWith('changes', 'src/foo.ts')
    const outcome = await showFileAction(context(async () => true), { path: 'src/foo.ts' })
    expect(outcome).toEqual({ ok: true, value: { path: 'src/foo.ts', existed: false } })
    expect(docs.openDocument).toHaveBeenCalledWith('s1', { kind: 'diff', group: 'changes', path: 'src/foo.ts' }, { focus: false, announce: 'Agent opened diff of foo.ts' })
  })

  it('reports an already open tab as existed, so it is activated rather than duplicated', async () => {
    docs.openDocument.mockReturnValue({ existed: true })
    expect(await showFileAction(context(async () => true), { path: 'a.txt' })).toEqual({ ok: true, value: { path: 'a.txt', existed: true } })
  })

  it.each([
    ['an unsafe path', { path: '../a.txt' }],
    ['a file that is not changed', { path: 'other.txt' }]
  ])('opens nothing for %s', async (_name, input) => {
    expect(await showFileAction(context(async () => true), input)).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(docs.openDocument).not.toHaveBeenCalled()
  })
})

describe('reveal', () => {
  const revealAction = handler('file-explorer', 'reveal')
  const tree = { path: '', kind: 'folder', expanded: true, children: [{ path: 'src', kind: 'folder', expanded: true, children: [{ path: 'src/foo.ts', kind: 'file' }] }] }

  beforeEach(() => {
    explorer.state.bySession = { s1: { root: tree } }
  })

  it('opens a file tab without taking focus', async () => {
    docs.openDocument.mockReturnValue({ existed: false })
    expect(await revealAction(context(async () => true), { path: 'src/foo.ts' })).toEqual({ ok: true, value: { path: 'src/foo.ts', kind: 'file' } })
    expect(docs.openDocument).toHaveBeenCalledWith('s1', { kind: 'file', path: 'src/foo.ts' }, { focus: false, announce: 'Agent opened foo.ts' })
  })

  it('selects a folder without opening a tab', async () => {
    expect(await revealAction(context(async () => true), { path: 'src' })).toEqual({ ok: true, value: { path: 'src', kind: 'folder' } })
    expect(explorer.state.setSelectedPath).toHaveBeenCalledWith('s1', 'src')
    expect(docs.openDocument).not.toHaveBeenCalled()
  })

  it('rejects an invalid path', async () => {
    expect(await revealAction(context(async () => true), { path: '../x' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(docs.openDocument).not.toHaveBeenCalled()
  })
})
