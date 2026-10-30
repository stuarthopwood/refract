// Spec 060 S2-16: the Command palette entry for the Usage view. The palette (#5) has not landed,
// so nothing registers this yet; until then the left-nav Usage item is the way in. When #5 lands,
// register `usageViewAction` with its action list.
import { useViewStore } from '@/state'

export const usageViewAction = {
  id: 'open-usage',
  label: 'Open Usage',
  run: (): void => useViewStore.getState().openUsage()
} as const
