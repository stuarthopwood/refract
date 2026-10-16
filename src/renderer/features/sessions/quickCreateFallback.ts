// Issue #559 decision 26: Ctrl+N's own "no repository resolved" fallback (App.tsx) normally
// focuses the quick-create "+" button on whichever Project header renders first. Once a search
// query can hide every Project's own "+" row entirely, that fallback is no longer only "no
// Projects yet" or "the nav is collapsed" -- the list can be open but filtered down to nothing.
//
// Gate round 1 fix (code-reviewer Medium): decides purely by OUTCOME, never by reading the
// query/repository count first. The earlier `query && repositoryCount > 0` guard gave the wrong
// message whenever the nav is collapsed (`App.tsx` keeps `<SessionList>` mounted but `inert`) --
// in that state `document.querySelector('[data-quick-create-session]')` still finds the (inert)
// "+" button, so the search field is never the real obstacle, yet the old guard could not tell
// the two cases apart. Now: the filter wording fires only when BOTH (a) no quick-create button
// exists in the DOM at all (every Project group is actually absent, the search-hides-everything
// case) AND (b) focusing the search field genuinely worked (not inert, not absent). Any other
// reason focus could not reach a target -- the nav collapsed, zero Projects at all -- falls
// through to the original "Open the session list…" wording.
import { useChatAreaAnnouncer } from '@/features/chat/chatAreaAnnouncer'

export function announceQuickCreateFallback(): void {
  const quickCreateButton = document.querySelector('[data-quick-create-session]')
  const searchInput = document.querySelector<HTMLInputElement>('[data-session-search-input]')
  if (!quickCreateButton && searchInput) {
    searchInput.focus()
    if (document.activeElement === searchInput) {
      useChatAreaAnnouncer.getState().announce('Clear the filter to choose a project for the new session')
      return
    }
  }
  useChatAreaAnnouncer.getState().announce('Open the session list to choose a project for the new session')
}
