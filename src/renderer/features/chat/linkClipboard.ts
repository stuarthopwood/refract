import { toast } from 'sonner'
import { notify } from '@/state'
import { sanitiseForClipboard } from '@/lib/clipboard-sanitise'
import { copyDecision } from '@/lib/clipboard-copy-decision'

// Same sanitising and try order as `CopyButton` (so the button and the menu put identical text on
// the clipboard): the renderer's own Clipboard API first, then main's allowlisted clipboard channel
// when the webview refuses it.
export async function copyLinkText(text: string, successMessage: string): Promise<void> {
  const decision = copyDecision(sanitiseForClipboard(text))
  if (decision.kind === 'nothing') {
    notify({ code: 'clipboard-failed', message: 'Nothing to copy: this link only contains hidden characters' })
    return
  }
  try {
    await navigator.clipboard.writeText(decision.text)
    toast.success(successMessage)
    return
  } catch {
    // fall through to the main-process clipboard channel
  }
  try {
    const result = await window.refract.clipboard.writeText(decision.text)
    if (result.ok) toast.success(successMessage)
    else notify(result.error)
  } catch (err) {
    notify({ code: 'clipboard-failed', message: err instanceof Error ? err.message : String(err) })
  }
}
