import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SubStep } from '../viewModel'
import { SUB_STEP_CAP, SubStepList, foldSubSteps } from './SubStepList'

const steps = (done: number, running: number, pending: number): SubStep[] => [
  ...Array.from({ length: done }, (_, i): SubStep => ({ label: `done ${i}`, status: 'done' })),
  ...Array.from({ length: running }, (_, i): SubStep => ({ label: `run ${i}`, status: 'running' })),
  ...Array.from({ length: pending }, (_, i): SubStep => ({ label: `todo ${i}`, status: 'pending' }))
]
const labels = (list: SubStep[]) => foldSubSteps(list).visible.map(({ step }) => step.label)

describe('foldSubSteps (#1928)', () => {
  it('caps the list at six', () => {
    expect(SUB_STEP_CAP).toBe(6)
  })

  it('shows every step, in order, when there are at most six', () => {
    const folded = foldSubSteps(steps(2, 1, 3))
    expect(folded.visible.map(({ index }) => index)).toEqual([0, 1, 2, 3, 4, 5])
    expect(folded).toMatchObject({ doneFolded: 0, queued: 0 })
  })

  it('folds the oldest done steps into "N done" and the furthest pending into "+N queued", always keeping the running one', () => {
    const folded = foldSubSteps(steps(4, 1, 5))
    expect(folded.visible).toHaveLength(6)
    expect(labels(steps(4, 1, 5))).toEqual(['done 1', 'done 2', 'done 3', 'run 0', 'todo 0', 'todo 1'])
    expect(folded.doneFolded).toBe(1)
    expect(folded.queued).toBe(3)
  })

  it('keeps the running step even when a long done history would fill the cap', () => {
    const list = steps(20, 1, 0)
    expect(labels(list)).toContain('run 0')
    expect(labels(list)).toHaveLength(6)
    expect(foldSubSteps(list)).toMatchObject({ doneFolded: 15, queued: 0 })
  })

  it('gives unused pending room to done steps and the reverse', () => {
    expect(foldSubSteps(steps(8, 0, 0))).toMatchObject({ doneFolded: 2, queued: 0 })
    expect(foldSubSteps(steps(0, 0, 8))).toMatchObject({ doneFolded: 0, queued: 2 })
    expect(foldSubSteps(steps(1, 1, 9))).toMatchObject({ doneFolded: 0, queued: 5 })
  })

  it('never hides a running step, even when more than six run at once', () => {
    const folded = foldSubSteps(steps(2, 8, 2))
    expect(folded.visible.filter(({ step }) => step.status === 'running')).toHaveLength(8)
    expect(folded).toMatchObject({ doneFolded: 2, queued: 2 })
  })
})

describe('SubStepList (#1928)', () => {
  const render = (list: SubStep[] | undefined) => renderToStaticMarkup(createElement(SubStepList, { steps: list }))

  it('renders nothing for an absent or empty list', () => {
    expect(render(undefined)).toBe('')
    expect(render([])).toBe('')
  })

  it('names each step state in text, so a state is never colour or icon alone', () => {
    const html = render([{ label: 'Read', status: 'done' }, { label: 'Edit', status: 'running' }, { label: 'Test', status: 'pending' }])
    expect(html).toContain('Read<span class="sr-only"> (done)</span>')
    expect(html).toContain('Edit<span class="sr-only"> (running)</span>')
    expect(html).toContain('Test<span class="sr-only"> (queued)</span>')
  })

  it('marks a failed done step as failed, not as success', () => {
    const html = render([{ label: 'Lint', status: 'done', isError: true }])
    expect(html).toContain('(failed)')
    expect(html).toContain('text-severity-error')
  })

  it('emphasises the running step and stops the spinner under reduced motion', () => {
    const html = render([{ label: 'Edit', status: 'running' }])
    expect(html).toContain('font-medium')
    expect(html).toContain('motion-reduce:animate-none')
  })

  it('shows the "N done" and "+N queued" lines only when steps were folded', () => {
    expect(render(steps(2, 1, 2))).not.toMatch(/\d+ done<|queued</)
    const html = render(steps(4, 1, 5))
    expect(html).toContain('>1 done<')
    expect(html).toContain('>+3 queued<')
  })
})
