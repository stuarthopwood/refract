// #1750: the Pseudo view of a bash command. A static reading of the command text only (OMP keeps its
// trace data for its own terminal UI; see can1357/oh-my-pi#18296), so there are no values, no state
// and no replay. Anything this reader does not model (substitution, heredocs, loops, functions)
// makes it refuse, and the dialog falls back to the Raw text instead of showing a wrong reading.

export type PseudoKind = 'command' | 'cd' | 'pipe' | 'redirect' | 'assign' | 'condition' | 'subshell' | 'background'

export interface PseudoStep {
  kind: PseudoKind
  /** Nesting level: the steps a condition guards and the body of a subshell sit one deeper. */
  depth: number
  /** The step as a Python-like line. */
  text: string
}

export type PseudoResult = { ok: true; steps: PseudoStep[] } | { ok: false }

// Past this the command is more likely a pasted script than a pipeline, and a quadratic-ish reading
// of it is not worth the dialog's time.
const MAX_COMMAND_CHARS = 20_000
const MAX_STEPS = 400

type Redirect = '>' | '>>' | '<' | '>&' | '&>' | '&>>'
type Operator = '&&' | '||' | '|' | ';' | '&' | '(' | ')' | '\n'
type Token =
  | { t: 'word'; v: string; quoted: boolean; assign?: { name: string; value: string } }
  | { t: 'op'; v: Operator }
  | { t: 'redir'; fd: string | null; op: Redirect }

class Refuse extends Error {}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
// Words that open shell syntax this reader does not model, so they must never be read as a command name.
const RESERVED: Record<string, true> = {
  if: true, then: true, else: true, elif: true, fi: true, for: true, while: true, until: true, do: true, done: true,
  case: true, esac: true, function: true, select: true, '{': true, '}': true, '!': true, '[[': true, coproc: true
}

function refuse(): never {
  throw new Refuse()
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let buf = ''
  let active = false
  let quoted = false
  let eqAt = -1
  let sawQuote = false

  const flush = () => {
    if (!active) return
    const token: Token = { t: 'word', v: buf, quoted }
    if (eqAt > 0) token.assign = { name: buf.slice(0, eqAt - 1), value: buf.slice(eqAt) }
    tokens.push(token)
    buf = ''
    active = false
    quoted = false
    eqAt = -1
    sawQuote = false
  }

  let i = 0
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (ch === '\\') {
      if (next === undefined) refuse()
      if (next === '\n') {
        i += 2
        continue
      }
      buf += next
      active = quoted = sawQuote = true
      i += 2
    } else if (ch === "'") {
      const end = src.indexOf("'", i + 1)
      if (end === -1) refuse()
      buf += src.slice(i + 1, end)
      active = quoted = sawQuote = true
      i = end + 1
    } else if (ch === '"') {
      i++
      for (;;) {
        const c = src[i]
        if (c === undefined) refuse()
        if (c === '"') break
        if (c === '`' || (c === '$' && src[i + 1] === '(')) refuse()
        if (c === '\\') {
          const escaped = src[i + 1]
          if (escaped === undefined) refuse()
          if (escaped === '\n') {
            i += 2
            continue
          }
          buf += '"$`\\'.includes(escaped) ? escaped : `\\${escaped}`
          i += 2
          continue
        }
        buf += c
        i++
      }
      i++
      active = quoted = sawQuote = true
    } else if (ch === '`') {
      refuse()
    } else if (ch === '$') {
      // `$(...)` runs another command, `${...}` can hold operators this tokenizer would split, and
      // `$'...'` / `$"..."` change what the quotes mean.
      if (next === '(' || next === '{' || next === "'" || next === '"') refuse()
      buf += ch
      active = true
      i++
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush()
      i++
    } else if (ch === '\n') {
      flush()
      tokens.push({ t: 'op', v: '\n' })
      i++
    } else if (ch === '#' && !active) {
      while (i < src.length && src[i] !== '\n') i++
    } else if (ch === '>' || ch === '<') {
      const fd = active && /^[0-9]+$/.test(buf) && !quoted ? buf : null
      if (fd !== null) {
        buf = ''
        active = false
        eqAt = -1
      } else flush()
      if (next === '(' || (ch === '<' && (next === '<' || next === '&')) || (ch === '>' && next === '|')) refuse()
      if (ch === '<') {
        tokens.push({ t: 'redir', fd, op: '<' })
        i++
      } else if (next === '>') {
        tokens.push({ t: 'redir', fd, op: '>>' })
        i += 2
      } else if (next === '&') {
        tokens.push({ t: 'redir', fd, op: '>&' })
        i += 2
      } else {
        tokens.push({ t: 'redir', fd, op: '>' })
        i++
      }
    } else if (ch === '&' || ch === '|' || ch === ';' || ch === '(' || ch === ')') {
      flush()
      // `((` opens arithmetic, which is not two nested subshells.
      if (ch === '(' && next === '(') refuse()
      if (ch === '&' && next === '>') {
        const append = src[i + 2] === '>'
        tokens.push({ t: 'redir', fd: null, op: append ? '&>>' : '&>' })
        i += append ? 3 : 2
      } else if ((ch === '&' || ch === '|') && next === ch) {
        tokens.push({ t: 'op', v: ch === '&' ? '&&' : '||' })
        i += 2
      } else if ((ch === '|' && next === '&') || (ch === ';' && next === ';')) {
        refuse()
      } else {
        tokens.push({ t: 'op', v: ch })
        i++
      }
    } else {
      if (ch === '=' && eqAt === -1 && !sawQuote && IDENT.test(buf)) eqAt = buf.length + 1
      buf += ch
      active = true
      i++
    }
  }
  flush()
  return tokens
}

const q = (value: string) => JSON.stringify(value)

function callText(name: string, args: string[]): string {
  const head = IDENT.test(name) ? `${name}(` : `run(${q(name)}${args.length > 0 ? ', ' : ''}`
  return `${head}${args.join(', ')})`
}

// The descriptor a redirect acts on: its own number, else the stream its operator defaults to.
function streamName(fd: string | null, fallback: '0' | '1'): string {
  const n = fd ?? fallback
  return n === '0' ? 'stdin' : n === '1' ? 'stdout' : n === '2' ? 'stderr' : `fd${n}`
}

function redirectText(fd: string | null, op: Redirect, target: string): string {
  if (op === '&>' || op === '&>>') return `stdout+stderr ${op === '&>' ? '>' : '>>'} ${q(target)}`
  // `>&word` is a stream join only for a descriptor or `-`; any other word is a file that gets both streams.
  if (op === '>&' && !/^([0-9]+|-)$/.test(target)) refuse()
  const stream = streamName(fd, op === '<' ? '0' : '1')
  if (op === '>&') {
    const dest = target === '1' ? 'stdout' : target === '2' ? 'stderr' : target === '-' ? 'closed' : `fd ${q(target)}`
    return `${stream} -> ${dest}`
  }
  return `${stream} ${op} ${q(target)}`
}

function parse(tokens: Token[]): PseudoStep[] {
  const steps: PseudoStep[] = []
  let pos = 0

  const emit = (kind: PseudoKind, depth: number, text: string) => {
    if (steps.length >= MAX_STEPS) refuse()
    steps.push({ kind, depth, text })
  }
  const peekOp = (): Operator | undefined => {
    const token = tokens[pos]
    return token?.t === 'op' ? token.v : undefined
  }

  // One command: leading assignments, the name, its arguments and redirects, in any interleaving
  // the shell allows. Redirects are emitted after the command they belong to.
  function simple(depth: number, kind: 'command' | 'pipe'): void {
    const env: Array<[string, string]> = []
    const args: string[] = []
    const redirects: string[] = []
    let name: string | undefined
    let sawAssignOnly = false
    for (;;) {
      const token = tokens[pos]
      if (!token || token.t === 'op') break
      pos++
      if (token.t === 'redir') {
        const target = tokens[pos]
        if (target?.t !== 'word') refuse()
        pos++
        redirects.push(redirectText(token.fd, token.op, target.v))
        continue
      }
      if (name === undefined) {
        if (token.assign) {
          env.push([token.assign.name, token.assign.value])
          sawAssignOnly = true
          continue
        }
        if (!token.quoted && Object.hasOwn(RESERVED, token.v)) refuse()
        name = token.v
        sawAssignOnly = false
      } else args.push(q(token.v))
    }
    if (name === undefined) {
      if (!sawAssignOnly && redirects.length === 0) refuse()
      for (const [key, value] of env) emit('assign', depth, `${key} = ${q(value)}`)
    } else {
      if (env.length > 0) args.push(`env={${env.map(([key, value]) => `${q(key)}: ${q(value)}`).join(', ')}}`)
      emit(name === 'cd' && kind === 'command' ? 'cd' : kind, depth, callText(name, args))
    }
    for (const text of redirects) emit('redirect', depth, text)
  }

  function stage(depth: number, kind: 'command' | 'pipe'): void {
    const token = tokens[pos]
    if (token?.t !== 'op' || token.v !== '(') return simple(depth, kind)
    pos++
    emit(kind === 'pipe' ? 'pipe' : 'subshell', depth, 'subshell():')
    list(depth + 1)
    if (peekOp() !== ')') refuse()
    pos++
    for (;;) {
      const redirect = tokens[pos]
      if (redirect?.t !== 'redir') break
      pos++
      const target = tokens[pos]
      if (target?.t !== 'word') refuse()
      pos++
      emit('redirect', depth, redirectText(redirect.fd, redirect.op, target.v))
    }
  }

  function pipeline(depth: number): void {
    stage(depth, 'command')
    while (peekOp() === '|') {
      pos++
      while (peekOp() === '\n') pos++
      stage(depth, 'pipe')
    }
  }

  function andOr(depth: number): void {
    pipeline(depth)
    for (;;) {
      const op = peekOp()
      if (op !== '&&' && op !== '||') return
      pos++
      while (peekOp() === '\n') pos++
      emit('condition', depth, op === '&&' ? 'if previous succeeded:' : 'if previous failed:')
      pipeline(depth + 1)
    }
  }

  function list(depth: number): void {
    for (;;) {
      while (peekOp() === ';' || peekOp() === '\n') pos++
      if (pos >= tokens.length || peekOp() === ')') return
      andOr(depth)
      if (peekOp() === '&') {
        pos++
        emit('background', depth, '# the steps above run in the background')
      } else if (pos < tokens.length && peekOp() !== ';' && peekOp() !== '\n' && peekOp() !== ')') refuse()
    }
  }

  list(0)
  if (pos < tokens.length) refuse()
  return steps
}

export function parsePseudoShell(command: string): PseudoResult {
  if (command.trim() === '' || command.length > MAX_COMMAND_CHARS) return { ok: false }
  try {
    const steps = parse(tokenize(command))
    return steps.length > 0 ? { ok: true, steps } : { ok: false }
  } catch (error) {
    if (error instanceof Refuse) return { ok: false }
    throw error
  }
}
