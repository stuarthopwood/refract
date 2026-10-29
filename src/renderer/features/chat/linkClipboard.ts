import { toast } from 'sonner'
import { notify } from '@/state'

// Same try order as `useWorktreeActions.ts`'s `copyPath` and `CopyButton`: the renderer's own
// Clipboard API first, then main's allowlisted clipboard channel when the webview refuses it.
export async function copyLinkText(text: string, successMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(successMessage)
    return
  } catch {
    // fall through to the main-process clipboard channel
  }
  try {
    const result = await window.refract.clipboard.writeText(text)
    if (result.ok) toast.success(successMessage)
    else notify(result.error)
  } catch (err) {
    notify({ code: 'clipboard-failed', message: err instanceof Error ? err.message : String(err) })
  }
}
