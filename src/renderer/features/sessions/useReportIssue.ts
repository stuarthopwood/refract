// State for the Report an issue dialog (issue #503, spec 049): the repository's labels, the
// debounced duplicate check, and the submit. Every call goes through `window.refract.issues`,
// which Rust validates and runs as an argv-array `gh` call (Constitution Principle V).
import { useEffect, useState } from 'react'
import type { CreatedIssue, IssueLabel, IssueMatch } from '../../../shared/ipc-issues'

export const ISSUE_TITLE_MAX = 256
const DUPLICATE_DEBOUNCE_MS = 400
const DUPLICATE_MIN_CHARS = 4

export interface IssueFormState {
  title: string
  body: string
  labels: string[]
}

export function useIssueLabels(repositoryId: string, active: boolean): { labels: IssueLabel[]; failed: boolean } {
  const [labels, setLabels] = useState<IssueLabel[]>([])
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    void window.refract.issues.labels(repositoryId).then((result) => {
      if (cancelled) return
      setFailed(!result.ok)
      setLabels(result.ok ? result.value : [])
    })
    return () => {
      cancelled = true
    }
  }, [repositoryId, active])
  return { labels, failed }
}

/** Up to 5 issues similar to `title`, refreshed 400 ms after the last keystroke. A failed search
 * is silent: the duplicate check is advice and never blocks filing. */
export function useDuplicateIssues(repositoryId: string, title: string, active: boolean): IssueMatch[] {
  const [matches, setMatches] = useState<IssueMatch[]>([])
  useEffect(() => {
    const query = title.trim()
    if (!active || query.length < DUPLICATE_MIN_CHARS) {
      setMatches([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.refract.issues.search(repositoryId, query).then((result) => {
        if (!cancelled) setMatches(result.ok ? result.value : [])
      })
    }, DUPLICATE_DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [repositoryId, title, active])
  return matches
}

export type SubmitOutcome = { ok: true; issue: CreatedIssue } | { ok: false; message: string }

export async function submitIssue(repositoryId: string, form: IssueFormState): Promise<SubmitOutcome> {
  try {
    const result = await window.refract.issues.create(repositoryId, form.title.trim(), form.body, form.labels)
    return result.ok ? { ok: true, issue: result.value } : { ok: false, message: result.error.message }
  } catch {
    return { ok: false, message: 'Could not reach GitHub. Try again.' }
  }
}
