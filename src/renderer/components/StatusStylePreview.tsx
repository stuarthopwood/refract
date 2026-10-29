import { StateIcon, STATUS_LABEL } from '@/features/sessions/sessionDisplay'
import type { SessionDisplayStatus } from '@/features/sessions/sessionDisplay'
import type { StatusStyle } from '../../shared/statusStyle'

const STATES: readonly SessionDisplayStatus[] = ['idle', 'working', 'needs-you', 'stopped', 'unread-response']

/** Issue #482: all five Session states drawn in one Status style, in the active theme. Phrasing
 * content only, so it can sit inside a button (a radio option); each state's word is visible, so
 * nothing relies on colour. */
export function StatusStylePreview({ style }: { style: StatusStyle }) {
  return (
    <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {STATES.map((state) => (
        <span key={state} role="presentation" className="flex items-center gap-2">
          <StateIcon status={state} style={style} />
          {STATUS_LABEL[state]}
        </span>
      ))}
    </span>
  )
}
