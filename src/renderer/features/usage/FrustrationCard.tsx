// Spec 060 S2-13: the frustration card (jokes on only). Counts of shouting, swearing and blame,
// and a mood sparkline of the daily mean. Scored locally from your own messages; no model calls.
import { StatCard } from '@/components/StatCard'
import { Sparkline } from '@/components/ui/chart'
import { ScreenSection } from '@/components/ScreenSection'
import type { UsageFrustration } from '../../../shared/ipc-usage'
import { frustrationCaption } from './captions'
import { formatInt } from './format'

export function FrustrationCard({ frustration }: { frustration: UsageFrustration }) {
  const total = frustration.yelling + frustration.profanity + frustration.blame
  const perMessage = frustration.messages > 0 ? total / frustration.messages : 0
  return (
    <ScreenSection
      title="Frustration index"
      note="Counted on this machine from your own messages. Nothing is sent anywhere."
      empty={frustration.messages === 0 ? 'No messages in this range.' : null}
    >
      <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4">
        <StatCard label="Yelling" value={formatInt(frustration.yelling)} />
        <StatCard label="Profanity" value={formatInt(frustration.profanity)} />
        <StatCard label="Blame" value={formatInt(frustration.blame)} />
        <StatCard label="Mood" value={`${perMessage.toFixed(2)} per message`} caption={frustrationCaption(perMessage)} />
      </div>
      {frustration.daily.length > 1 && (
        <Sparkline label="Mood by day, higher is angrier" values={frustration.daily.map((d) => d.mood)} formatValue={(n) => n.toFixed(2)} />
      )}
    </ScreenSection>
  )
}
