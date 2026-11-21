import type { ChecklistItem } from '../../../../shared/checklist'

/** True when ticking the item would be refused for lack of a value; the row explains it and the store does not ask. */
export const needsValueToTick = (item: ChecklistItem): boolean => item.status !== 'complete' && item.requiresValue && !item.value
