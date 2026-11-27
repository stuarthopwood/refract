import { describe, expect, it } from 'vitest'
import { summarizeSubagentStatuses } from '../subagents/subagentStatus'
import { extractContextLabel, extractResultSummary, plainSummary, stripTaskResultWrapper, stripWorktreePaths, unsettledRollupText } from './stageMeta'

describe('extractResultSummary (#2242)', () => {
  const wrapped = '<task-result id="AwaySpecLane" agent="task" status="completed" duration="3m31s">\n## Fixed the **flaky** test\nMore detail\n</task-result>'

  it('drops the OMP <task-result> wrapper and the heading marker, keeping inline Markdown for the card to render', () => {
    expect(extractResultSummary(wrapped)).toBe('Fixed the **flaky** test')
  })

  it('returns undefined for a wrapper with nothing inside', () => {
    expect(extractResultSummary('<task-result id="A" status="completed"></task-result>')).toBeUndefined()
  })

  it('removes only the wrapper tags in stripTaskResultWrapper', () => {
    expect(stripTaskResultWrapper(wrapped)).toBe('## Fixed the **flaky** test\nMore detail')
  })

  it('flattens a summary to plain words for tooltips and accessible names', () => {
    expect(plainSummary('Fixed **two** `a.ts` bugs, see [the PR](https://x.test/1)')).toBe('Fixed two a.ts bugs, see the PR')
  })
})

describe('extractResultSummary truncation and block markers (#2242)', () => {
  it('keeps a 120-character line whole', () => {
    const line = 'a'.repeat(120)
    expect(extractResultSummary(line)).toBe(line)
  })

  it('cuts a 121-character line to 120 characters plus an ellipsis', () => {
    expect(extractResultSummary('a'.repeat(121))).toBe(`${'a'.repeat(120)}\u2026`)
  })

  it('drops a leading list marker', () => {
    expect(extractResultSummary('- Fixed the test')).toBe('Fixed the test')
  })

  it('drops a leading star list marker', () => {
    expect(extractResultSummary('* Fixed the test')).toBe('Fixed the test')
  })

  it('drops a leading quote marker', () => {
    expect(extractResultSummary('> Fixed the test')).toBe('Fixed the test')
  })

  it('skips a line that is only a marker and uses the next', () => {
    expect(extractResultSummary('-\n\nFixed the test')).toBe('Fixed the test')
  })
})

describe('stripTaskResultWrapper edges (#2242)', () => {
  it('strips an opening tag with no closing tag', () => {
    expect(stripTaskResultWrapper('<task-result id="A" status="completed">\nDone')).toBe('Done')
  })

  it('strips a closing tag with no opening tag', () => {
    expect(stripTaskResultWrapper('Done\n</task-result>')).toBe('Done')
  })

  it('strips an upper-case wrapper', () => {
    expect(stripTaskResultWrapper('<TASK-RESULT id="A">\nDone\n</TASK-RESULT>')).toBe('Done')
  })

  it('tolerates an opening tag cut off before its `>`', () => {
    expect(stripTaskResultWrapper('<task-result id="A" stat\nDone')).toBe('Done')
  })

  it('does not let a later quote marker widen a cut-off opening tag', () => {
    expect(stripTaskResultWrapper('<task-result id="A"\n> quoted line')).toBe('> quoted line')
  })

  it('keeps a task-result tag quoted inside a code fence', () => {
    const body = 'Use:\n```\n<task-result id="x">\nhi\n</task-result>\n```\nDone'
    expect(stripTaskResultWrapper(`<task-result id="A">\n${body}\n</task-result>`)).toBe(body)
  })

  it('does not touch a tag that merely starts with the same letters', () => {
    expect(stripTaskResultWrapper('<task-results>\nDone')).toBe('<task-results>\nDone')
  })
})

describe('plainSummary (#2242)', () => {
  it('keeps a lone asterisk used as a multiplication sign', () => {
    expect(plainSummary('Computed 2 * 3 and 4 * 5')).toBe('Computed 2 * 3 and 4 * 5')
  })

  it('keeps a lone double underscore', () => {
    expect(plainSummary('Renamed a __ b')).toBe('Renamed a __ b')
  })

  it('keeps underscores inside an identifier', () => {
    expect(plainSummary('Fixed snake_case_name and my_var')).toBe('Fixed snake_case_name and my_var')
  })

  it('strips paired single-asterisk and underscore emphasis', () => {
    expect(plainSummary('It was *really* _quite_ good')).toBe('It was really quite good')
  })

  it('strips paired bold, strikethrough and code markers', () => {
    expect(plainSummary('**bold** ~~gone~~ `code`')).toBe('bold gone code')
  })

  it('does not read emphasis inside a code span', () => {
    expect(plainSummary('Ran `a * b * c`')).toBe('Ran a * b * c')
  })

  it('keeps a link label when the URL contains a closing parenthesis', () => {
    expect(plainSummary('See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) now')).toBe('See Foo now')
  })

  it('keeps the alt text of an image', () => {
    expect(plainSummary('![diagram](https://x.test/a.png) done')).toBe('diagram done')
  })
})

describe('stripWorktreePaths', () => {
  it('removes a Windows backslash worktree path and the whitespace it leaves', () => {
    expect(stripWorktreePaths('Repo C:\\Repos\\pinion\\worktrees\\lane-1\\src now')).toBe('Repo now')
  })

  it('removes a forward-slash path through a worktrees folder', () => {
    expect(stripWorktreePaths('Work in C:/Repos/x/worktrees/lane-2 please')).toBe('Work in please')
  })

  it('removes a home-relative ~/.../worktrees/... path', () => {
    expect(stripWorktreePaths('cwd ~/code/x/worktrees/lane-3/src done')).toBe('cwd done')
  })

  it('leaves text without a worktree path unchanged', () => {
    expect(stripWorktreePaths('Fix the flaky test')).toBe('Fix the flaky test')
  })
})

describe('extractContextLabel', () => {
  it('skips a line that is only a label for a stripped path and uses the next real line', () => {
    expect(extractContextLabel('Repo C:\\Repos\\x\\worktrees\\lane-1\nFix the flaky test')).toBe('Fix the flaky test')
  })

  it('keeps the raw first line when clean is false', () => {
    expect(extractContextLabel('Repo C:\\Repos\\x\\worktrees\\lane-1\nFix the flaky test', false)).toBe('Repo C:\\Repos\\x\\worktrees\\lane-1')
  })

  it('stops at a Rules (HARD) line instead of labelling from boilerplate', () => {
    expect(extractContextLabel('## Rules (HARD)\nNever push', true)).toBeNull()
  })
})

describe('unsettledRollupText', () => {
  it('names exited agents', () => {
    expect(unsettledRollupText(summarizeSubagentStatuses(['exited', 'finished']))).toBe('1 exited')
  })

  it('names parked agents', () => {
    expect(unsettledRollupText(summarizeSubagentStatuses(['parked', 'parked']))).toBe('2 parked')
  })

  it('drops zero counts and is empty when everything finished', () => {
    expect(unsettledRollupText(summarizeSubagentStatuses(['finished']))).toBe('')
  })
})
