import { ApprovalModePill } from './ApprovalModePill'
import { WorkingModeMenu } from './WorkingModeMenu'

/** The composer's per-Session mode controls: working mode, then the app-wide Approval mode. */
export function ComposerModePills({ sessionId }: { sessionId: string }) {
  return (
    <>
      <WorkingModeMenu sessionId={sessionId} />
      <ApprovalModePill sessionId={sessionId} />
    </>
  )
}
