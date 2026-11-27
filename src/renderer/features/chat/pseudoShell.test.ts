import { describe, expect, it } from 'vitest'
import { parsePseudoShell, type PseudoStep } from './pseudoShell'

function steps(command: string): Array<[string, number, string]> {
  const result = parsePseudoShell(command)
  if (!result.ok) throw new Error(`refused: ${command}`)
  return result.steps.map((step: PseudoStep) => [step.kind, step.depth, step.text])
}

describe('parsePseudoShell', () => {
  it('shows the change of directory, the diff, the pipe into head and the redirect as separate steps', () => {
    expect(steps('cd src && git diff | head -n 40 > out.txt')).toEqual([
      ['cd', 0, 'cd("src")'],
      ['condition', 0, 'if previous succeeded:'],
      ['command', 1, 'git("diff")'],
      ['pipe', 1, 'head("-n", "40")'],
      ['redirect', 1, 'stdout > "out.txt"']
    ])
  })

  it('reads || as a failure condition and ; and newlines as plain sequencing', () => {
    expect(steps('make || echo failed; ls\npwd')).toEqual([
      ['command', 0, 'make()'],
      ['condition', 0, 'if previous failed:'],
      ['command', 1, 'echo("failed")'],
      ['command', 0, 'ls()'],
      ['command', 0, 'pwd()']
    ])
  })

  it('reads redirects of every stream, appends and stream joins', () => {
    expect(steps('build >> log.txt 2> err.txt 2>&1 < in.txt &> all.txt').map(([, , text]) => text)).toEqual([
      'build()',
      'stdout >> "log.txt"',
      'stderr > "err.txt"',
      'stderr -> stdout',
      'stdin < "in.txt"',
      'stdout+stderr > "all.txt"'
    ])
  })

  it('shows variable assignments as steps and as the environment of the command they prefix', () => {
    expect(steps('FOO=bar; NODE_ENV="a b" node app.js')).toEqual([
      ['assign', 0, 'FOO = "bar"'],
      ['command', 0, 'node("app.js", env={"NODE_ENV": "a b"})']
    ])
  })

  it('nests the body of a subshell one level deeper', () => {
    expect(steps('(cd a; ls) | wc -l')).toEqual([
      ['subshell', 0, 'subshell():'],
      ['cd', 1, 'cd("a")'],
      ['command', 1, 'ls()'],
      ['pipe', 0, 'wc("-l")']
    ])
  })

  it('keeps quoted operators inside one argument and drops comments', () => {
    expect(steps(`echo "a && b" 'c | d' # trailing`)).toEqual([['command', 0, 'echo("a && b", "c | d")']])
  })

  it('names commands that are not identifiers through run()', () => {
    expect(steps('./scripts/build.sh --fast')).toEqual([['command', 0, 'run("./scripts/build.sh", "--fast")']])
  })

  it('marks a background command', () => {
    expect(steps('server &').map(([kind]) => kind)).toEqual(['command', 'background'])
  })

  it.each([
    ['command substitution', 'echo $(date)'],
    ['backticks', 'echo `date`'],
    ['substitution inside double quotes', 'echo "$(date)"'],
    ['a heredoc', 'cat <<EOF\nhi\nEOF'],
    ['process substitution', 'diff <(ls a) <(ls b)'],
    ['a loop', 'for f in *; do echo $f; done'],
    ['a conditional', 'if true; then ls; fi'],
    ['an unterminated quote', 'echo "oops'],
    ['an unbalanced subshell', '(ls'],
    ['a dangling pipe', 'ls |'],
    ['an empty command', '   '],
    ['arithmetic evaluation', '((i++))'],
    ['arithmetic evaluation with spaces inside', '(( x > 3 )) && echo big'],
    ['a file named by >& rather than a stream', 'cmd >&out.txt'],
    ['a file named by 2>&', 'cmd 2>&out.txt'],
    ['a stream named by letters after >&', 'cmd >&err'],
    ['an unquoted parameter expansion', 'echo ${HOME:-a;b}'],
    ['a parameter expansion with an operator', 'echo ${x%%a|b}']
  ])('refuses %s', (_name, command) => {
    expect(parsePseudoShell(command)).toEqual({ ok: false })
  })

  it('does not treat a quoted reserved word as syntax', () => {
    expect(steps('"if" x')).toEqual([['command', 0, 'if("x")']])
  })

  it('keeps a quoted parameter expansion as plain text', () => {
    expect(steps('echo "${HOME}"')).toEqual([['command', 0, 'echo("${HOME}")']])
  })

  it('keeps a subshell that holds a subshell, which the arithmetic refusal must not catch', () => {
    expect(steps('( (ls) )').map(([, depth, text]) => [depth, text])).toEqual([
      [0, 'subshell():'],
      [1, 'subshell():'],
      [2, 'ls()']
    ])
  })

  it('still reads a stream join and a closed stream after the >& refusal', () => {
    expect(steps('cmd 2>&1 >&2 2>&-').map(([, , text]) => text)).toEqual(['cmd()', 'stderr -> stdout', 'stdout -> stderr', 'stderr -> closed'])
  })

  it('names a redirect from a descriptor other than 0 by that descriptor, not as stdin', () => {
    expect(steps('cat 3<in.txt').map(([, , text]) => text)).toEqual(['cat()', 'fd3 < "in.txt"'])
  })

  it('reads a redirect from descriptor 0 and a bare < as stdin', () => {
    expect(steps('cat 0<a.txt <b.txt').map(([, , text]) => text)).toEqual(['cat()', 'stdin < "a.txt"', 'stdin < "b.txt"'])
  })

  describe('size limits', () => {
    it('reads a command of exactly 20,000 characters and refuses 20,001', () => {
      const atLimit = `echo ${'a'.repeat(19_995)}`
      expect(atLimit).toHaveLength(20_000)
      expect(parsePseudoShell(atLimit).ok).toBe(true)
      expect(parsePseudoShell(`${atLimit}a`)).toEqual({ ok: false })
    })

    it('reads a command of exactly 400 steps and refuses 401', () => {
      const lines = (n: number) => Array.from({ length: n }, () => 'ls').join('\n')
      expect(parsePseudoShell(lines(400)).ok).toBe(true)
      expect(parsePseudoShell(lines(401))).toEqual({ ok: false })
    })
  })
})
