import type { TranscriptItem } from '../../../shared/model'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>

function stringField(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// #632 section 3: command-style calls get a one-line form that reads like what they did, instead
// of the tool's raw target shown untouched (the issue's own example: `$ cd …; git diff …`, never
// a bare `cd …; git diff …` that reads as a path). Only `bash` and `grep` need reshaping here --
// `glob`/`find` already show their own pattern as `item.target` (the Row text column is just the
// pattern, unchanged), `read`'s target already carries its own `:start-end` range suffix when one
// was given (the tool's own argument convention, not something this file adds), and `write`/`edit`
// already show their own path. A tool with no special form (or an item outside this table) falls
// back to its own raw `item.target`, matching #469's "no special form falls back to today's row".
// Gate round 1 (code-reviewer/ui-architect-v3 Medium, M2): a `bash`/`grep` row's own `summary`
// text already names the tool (`$ <command>` reads as a shell prompt; `grep "<pattern>"`
// literally repeats the word), so a caller's own separate `label` showing the bare tool name too
// read as a duplicate ("grep grep \"...\""). Exported so `ToolRow.tsx`'s two command-style call
// sites (the solo `ToolGroupRow` branch and each nested `ToolCallRow`) agree on exactly which
// tools this applies to, matching this file's own reshaping table one-for-one.
// Gate round 1 (Main, D3, Security Low): a plain object's `[item.tool]` lookup is vulnerable to
// an inherited prototype property (e.g. `item.tool === 'toString'`); a `Set` with `.has` has no
// such surface.
export const COMMAND_STYLE_TOOLS: ReadonlySet<string> = new Set(['bash', 'grep'])
export function commandRowText(item: ToolItem): string {
  if (item.tool === 'bash') {
    // The command can be (and often is) multi-line (`cd a; \n gh pr merge ...`); only the FIRST
    // NON-EMPTY line is shown, same as the mockup's `$ cd …/docs-plan-c; git diff --stat
    // origin/main; …`. Gate round 1 (code-reviewer Medium, M4): a bare first line (which could
    // itself be blank, e.g. a leading newline) used to give no signal that further lines
    // existed; a trailing " …" now marks the row whenever the command actually has more than
    // one NON-EMPTY line, so it never silently implies a one-line command was the whole thing
    // (the full text is still only ever a click away, the "View full call" dialog, #628). Gate
    // round 1 (Main, D5): counted on the RAW line count before -- a trailing blank line (e.g.
    // `ls\n`) wrongly marked a genuinely one-line command as multi-line; counts non-empty lines.
    const lines = item.target.split(/\r\n|\n|\r/)
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    const firstNonEmptyLine = nonEmptyLines[0] ?? ''
    return `$ ${firstNonEmptyLine}${nonEmptyLines.length > 1 ? ' …' : ''}`
  }
  if (item.tool === 'grep') {
    // `item.target` is the pattern alone (`extract_target` in `transcript.rs`); the search path
    // is a separate argument, read directly off the call's own `args` when it is a plain string
    // (never guessed, never shown when the shape doesn't match -- same "no wrong fact" rule the
    // derived result below follows).
    const path = stringField(item.args, 'path')
    return path ? `grep "${item.target}" ${path}` : `grep "${item.target}"`
  }
  return item.target
}
