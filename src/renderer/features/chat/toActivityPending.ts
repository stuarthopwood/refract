import type { ActivityPending } from '../../../shared/activity'
import type { PendingRequest } from '../../../shared/model'

// A whole form has no single question to name, so the needs-you line shows a fixed label.
export function toActivityPending(request: PendingRequest | undefined): ActivityPending | null {
  if (!request) return null
  if (request.kind === 'approval') return { kind: 'approval', tool: request.tool, target: request.target || null }
  if (request.kind === 'form') return { kind: 'question', text: 'Form' }
  if (request.kind === 'question') return { kind: 'question', text: request.title }
  const first = request.questions[0]
  return first ? { kind: 'question', text: first.question } : null
}
