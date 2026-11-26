import { extractAgentRefs, extractResultSummary } from '../../chat/stageMeta'
import type { TranscriptSubagentItem } from './runs'

/** What a Stage run's own text yields; none of it depends on the readout summaries. */
export interface RunFacts {
  /** The shared `task()` context of the run: each distinct item context once, in order. */
  context: string | undefined
  /** The `agent://` ids the context and the tasks name. */
  agentRefs: readonly string[]
  /** One per item, in order: the first useful line of its result. */
  resultSummaries: readonly (string | undefined)[]
}

interface Snapshot {
  id: string
  task: string
  context: string | undefined
  result: string | undefined
}

// Bounded so a long-lived renderer does not keep every run it ever showed.
const MAX_CACHED_RUNS = 200
const cache = new Map<string, { snapshots: Snapshot[]; facts: RunFacts }>()

function computeFacts(items: readonly TranscriptSubagentItem[]): RunFacts {
  const contexts = [...new Set(items.map((item) => item.context).filter((c): c is string => Boolean(c)))]
  const context = contexts.length > 0 ? contexts.join('\n\n') : undefined
  return {
    context,
    agentRefs: extractAgentRefs([context ?? '', ...items.map((item) => item.task)].join('\n')),
    resultSummaries: items.map((item) => (item.result != null ? extractResultSummary(item.result) : undefined))
  }
}

function matches(snapshots: readonly Snapshot[], items: readonly TranscriptSubagentItem[]): boolean {
  return (
    snapshots.length === items.length &&
    snapshots.every((s, i) => {
      const item = items[i]!
      return s.id === item.id && s.task === item.task && s.context === item.context && s.result === item.result
    })
  )
}

/**
 * The text-derived facts of one run, reused while its items' ids, tasks, contexts and results are unchanged, so a settled run's
 * result and `agent://` scans do not repeat on every live readout update. The same object comes back on a hit.
 */
export function runFacts(items: readonly TranscriptSubagentItem[]): RunFacts {
  const key = items[0]!.id
  const hit = cache.get(key)
  if (hit && matches(hit.snapshots, items)) {
    cache.delete(key)
    cache.set(key, hit)
    return hit.facts
  }
  const facts = computeFacts(items)
  cache.delete(key)
  cache.set(key, { snapshots: items.map(({ id, task, context, result }) => ({ id, task, context, result })), facts })
  if (cache.size > MAX_CACHED_RUNS) cache.delete(cache.keys().next().value!)
  return facts
}
