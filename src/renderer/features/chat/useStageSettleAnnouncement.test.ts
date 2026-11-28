import { describe, expect, it } from 'vitest'
import type { StageGroup } from './groupSubagentStages'
import { detectStageSettle } from './useStageSettleAnnouncement'

function stage(id: string, stageIndex: number, statuses: string[], rollupText = '1 done'): StageGroup {
  return { id, stageIndex, items: statuses.map((status) => ({ status })), view: { rollupText } } as unknown as StageGroup
}

describe('detectStageSettle', () => {
  it('announces a Stage that was running and now is not, with its roll-up', () => {
    // Mutation: announce on any change, or drop the roll-up from the text.
    const first = detectStageSettle(new Map(), [stage('a', 1, ['running'])])
    const second = detectStageSettle(first.seen, [stage('a', 1, ['done'], '1 done, 1 failed')])
    expect(first.announcement).toBeUndefined()
    expect(second.announcement).toBe('Stage 1 finished, 1 done, 1 failed')
  })

  it('stays silent for a Stage first seen already settled, such as history loading', () => {
    // Mutation: treat a first sighting of a settled Stage as a settle.
    expect(detectStageSettle(new Map(), [stage('a', 1, ['done'])]).announcement).toBeUndefined()
  })

  it('stays silent while a Stage keeps running or stays settled', () => {
    // Mutation: announce every pass for a Stage that has not changed.
    const running = detectStageSettle(new Map([['a', true]]), [stage('a', 1, ['running', 'done'])])
    const settled = detectStageSettle(new Map([['a', false]]), [stage('a', 1, ['done'])])
    expect([running.announcement, settled.announcement]).toEqual([undefined, undefined])
  })

  it('announces only the last Stage when several settle in one pass', () => {
    // Mutation: announce the first settled Stage, or join them.
    const prev = new Map([['a', true], ['b', true]])
    const { announcement } = detectStageSettle(prev, [stage('a', 1, ['done']), stage('b', 2, ['done'], '2 done')])
    expect(announcement).toBe('Stage 2 finished, 2 done')
  })

  it('forgets a Stage that left the window, so its return is a first sighting', () => {
    // Mutation: keep every Stage ever seen in the remembered map.
    const away = detectStageSettle(new Map([['a', true]]), [])
    expect(away.seen.size).toBe(0)
    expect(detectStageSettle(away.seen, [stage('a', 1, ['done'])]).announcement).toBeUndefined()
  })
})
