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
// Gate round 1 (code-reviewer/ui-architect-v3 Medium, M2): a `bash`/`grep` row's own `summary`
// text already names the tool (`$ <command>` reads as a shell prompt; `grep "<pattern>"`
// literally repeats the word), so a caller's own separate `label` showing the bare tool name too
// read as a duplicate ("grep grep \"...\""). Exported so `ToolRow.tsx`'s two command-style call
// sites (the solo `ToolGroupRow` branch and each nested `ToolCallRow`) agree on exactly which
// tools this applies to, matching this file's own reshaping table one-for-one.
export const COMMAND_STYLE_TOOLS: Record<string, true> = { bash: true, grep: true }
export function commandRowText(item: ToolItem): string {
  if (item.tool === 'bash') {
    // The command can be (and often is) multi-line (`cd a; \n gh pr merge ...`); only the first
    // line is shown, same as the mockup's `$ cd …/docs-plan-c; git diff --stat origin/main; …`.
    const firstLine = item.target.split(/\r\n|\n|\r/, 1)[0] ?? item.target
    return `$ ${firstLine}`
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
