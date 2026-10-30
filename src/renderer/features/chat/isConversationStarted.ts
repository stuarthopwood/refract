import { STARTUP_NOTICE_PREFIX, type TranscriptItem } from '../../../shared/model';

export function isConversationStarted(items: readonly TranscriptItem[]): boolean {
  return items.some((item) => item.kind !== 'notice' || item.level === 'error' || !item.id.startsWith(STARTUP_NOTICE_PREFIX));
}
