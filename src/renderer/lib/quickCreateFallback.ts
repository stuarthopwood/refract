// Issue #559 decision 26: Ctrl+N's own "no repository resolved" fallback (App.tsx) normally
// focuses the quick-create "+" button on whichever Project header renders first. Once a search
// query can hide every Project's own "+" row entirely, that fallback is no longer only "no
// Projects yet" or "the nav is collapsed" -- the list can be open but filtered down to nothing.
// This focuses the search field and asks for the filter to be cleared instead, but only when a
// query is genuinely active and at least one real Project exists for it to be hiding (a
// genuinely empty session list keeps the older, still-correct message).
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'
import { useSessionListStore } from '@/state'

export function announceQuickCreateFallback(repositoryCount: number): void {
  const query = useSessionListStore.getState().query.trim()
  if (query && repositoryCount > 0) {
    document.querySelector<HTMLInputElement>('[data-session-search-region] input')?.focus()
    useChatAreaAnnouncer.getState().announce('Clear the filter to choose a project for the new session')
  } else {
    useChatAreaAnnouncer.getState().announce('Open the session list to choose a repository for the new session')
  }
}
