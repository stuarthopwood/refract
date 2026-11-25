import { Plug, Wrench, type LucideIcon } from 'lucide-react'
import { toolIntentLabel } from '../../../shared/toolIntentLabel'
import type { RowStatus } from './toolStatus'
import { sentenceCaseToolName, toolVerb, toolVerbEntry } from './toolVerbs'

// Spec 023 research Decision 5: the per-call view of a tool, derived from its id and target and
// never stored. `key` groups rows (FR-013), `entryTool` picks the verb map entry, `icon` is the
// leading glyph, and `rawId` is the tooltip and "Show tool names on rows" text (FR-011).
export interface ToolDisplay {
  key: string
  entryTool: string
  icon: LucideIcon
  rawId: string
}

const MCP_PREFIX = 'mcp__'
const XD_PREFIX = 'xd://'
const SKILL_PREFIX = 'skill://'

// `write xd://<tool>` stands for a call to `<tool>`; the name ends at the first path, query,
// fragment or whitespace character. An empty name is a plain write.
function xdTargetTool(tool: string, target: string | undefined): string | undefined {
  if (tool !== 'write' || !target?.startsWith(XD_PREFIX)) return undefined
  const name = target.slice(XD_PREFIX.length).split(/[/?#\s]/, 1)[0]
  return name === '' ? undefined : name
}

// A snapshot of the tools omp 19.1.1 mounts as shell commands (`src/tools/tool-commands.ts`): the rarely-used
// ones (`loadMode: "discoverable"`) plus the resolve-flow commands. MCP tools mount the same way.
const TOOL_COMMAND_NAMES: Readonly<Record<string, true>> = Object.freeze({
  ast_edit: true,
  ast_grep: true,
  checkpoint: true,
  debug: true,
  github: true,
  lsp: true,
  memory_edit: true,
  propose: true,
  recall: true,
  reflect: true,
  reject: true,
  resolve: true,
  retain: true,
  rewind: true,
  security_scan: true
})

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
const COMMAND_WORD_RE = /^[^\s;&|<>()]+/

const COMPOUND_SHELL_RE = /[;&|\r\n`]|\$\(/

// A v19 tool command is a `bash` call that is one simple command whose first word names a mounted tool.
// Leading `NAME=value` assignments are skipped; anything chained, piped or substituted after the tool word
// stays an ordinary bash row, as does any other first word.
function toolCommandName(tool: string, target: string | undefined): string | undefined {
  if (tool !== 'bash' || !target) return undefined
  let rest = target.trimStart()
  for (;;) {
    const word = COMMAND_WORD_RE.exec(rest)?.[0]
    if (word === undefined) return undefined
    if (ENV_ASSIGNMENT_RE.test(word)) {
      rest = rest.slice(word.length).trimStart()
      continue
    }
    if (!Object.hasOwn(TOOL_COMMAND_NAMES, word) && !word.startsWith(MCP_PREFIX)) return undefined
    return COMPOUND_SHELL_RE.test(rest.slice(word.length)) ? undefined : word
  }
}

function iconFor(tool: string): LucideIcon {
  if (tool.startsWith(MCP_PREFIX)) return Plug
  return toolVerbEntry(tool)?.icon ?? Wrench
}

export function resolveToolDisplay(tool: string, target?: string): ToolDisplay {
  const xdTool = xdTargetTool(tool, target)
  if (xdTool !== undefined) {
    return { key: `xd:${xdTool}`, entryTool: xdTool, icon: iconFor(xdTool), rawId: `write ${XD_PREFIX}${xdTool}` }
  }
  // omp 19 runs a rare tool as a `bash` call `<tool> <args>`; it shares the `xd:` key so it groups with the old `write xd://<tool>` form.
  const commandTool = toolCommandName(tool, target)
  if (commandTool !== undefined) {
    return { key: `xd:${commandTool}`, entryTool: commandTool, icon: iconFor(commandTool), rawId: `bash ${commandTool}` }
  }
  // A skill load (#543) reads `skill://<name>` and takes the skill entry's icon and verbs.
  if (tool === 'read' && target?.startsWith(SKILL_PREFIX)) {
    return { key: 'skill', entryTool: 'skill', icon: iconFor('skill'), rawId: tool }
  }
  return { key: tool, entryTool: tool, icon: iconFor(tool), rawId: tool }
}

// FR-004, FR-005, FR-007: an MCP tool reads as its name after `mcp__` in sentence case ("Tool"
// when empty), never split into server and tool (#1226); every other tool reads as its map form
// for the status, or its sentence-case name when unmapped.
function toolVerbLabel(entryTool: string, status: RowStatus): string {
  if (entryTool.startsWith(MCP_PREFIX)) return sentenceCaseToolName(entryTool.slice(MCP_PREFIX.length))
  return toolVerb(entryTool, status)
}

// FR-007, FR-140: the row label is the brief label of the call's intent when it has one, otherwise
// the tool's verb.
export function toolRowLabel(tool: string, target: string | undefined, intent: string | undefined, status: RowStatus): string {
  const trimmed = intent?.trim()
  if (trimmed) return toolIntentLabel(trimmed)
  return toolVerbLabel(resolveToolDisplay(tool, target).entryTool, status)
}
