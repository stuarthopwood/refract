import { Plug, Wrench, type LucideIcon } from 'lucide-react'
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

function iconFor(tool: string): LucideIcon {
  if (tool.startsWith(MCP_PREFIX)) return Plug
  return toolVerbEntry(tool)?.icon ?? Wrench
}

export function resolveToolDisplay(tool: string, target?: string): ToolDisplay {
  const xdTool = xdTargetTool(tool, target)
  if (xdTool !== undefined) {
    return { key: `xd:${xdTool}`, entryTool: xdTool, icon: iconFor(xdTool), rawId: `write ${XD_PREFIX}${xdTool}` }
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

// FR-007: the row label is the call's intent when it has one, otherwise the tool's verb.
export function toolRowLabel(tool: string, target: string | undefined, intent: string | undefined, status: RowStatus): string {
  const trimmed = intent?.trim()
  if (trimmed) return trimmed
  return toolVerbLabel(resolveToolDisplay(tool, target).entryTool, status)
}
