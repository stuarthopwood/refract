// Spec 060 S2-07: the Usage view's fixed caption templates, chosen by value. No model call and no
// randomness, so a given number always gets the same line. Callers pass `jokes` from the store
// and render nothing for an empty string.
import type { UsageSummary } from '../../../shared/ipc-usage'

type Tier = { below: number; text: string }

function pick(value: number, tiers: Tier[], last: string): string {
  for (const tier of tiers) if (value < tier.below) return tier.text
  return last
}

export type CaptionKey = 'spend' | 'credits' | 'calls' | 'tokens' | 'cache' | 'context' | 'tools' | 'toolErrors'

const CAPTIONS: Record<CaptionKey, { tiers: Tier[]; last: string }> = {
  spend: {
    tiers: [
      { below: 0.005, text: 'Nothing yet. The meter is bored.' },
      { below: 5, text: 'Pocket change. The robots are being polite.' },
      { below: 50, text: 'A decent lunch, but for tokens.' },
      { below: 500, text: 'The meter has opinions now.' }
    ],
    last: 'That is a small holiday, spent on thinking.'
  },
  credits: {
    tiers: [
      { below: 1, text: 'Barely a dent in the allowance.' },
      { below: 500, text: 'Steady nibbling at the plan.' },
      { below: 5000, text: 'The allowance is feeling it.' }
    ],
    last: 'Somebody is getting their money\'s worth.'
  },
  calls: {
    tiers: [
      { below: 1, text: 'Silence. Suspicious.' },
      { below: 200, text: 'A gentle chat.' },
      { below: 5000, text: 'The models are earning their keep.' }
    ],
    last: 'That is a lot of asking nicely.'
  },
  tokens: {
    tiers: [
      { below: 1, text: 'Zero. A clean slate.' },
      { below: 1_000_000, text: 'A short story\'s worth.' },
      { below: 100_000_000, text: 'Several novels, none of them finished.' }
    ],
    last: 'A library, read at speed.'
  },
  cache: {
    tiers: [
      { below: 0.3, text: 'Mostly fresh reads. The cache is lonely.' },
      { below: 0.7, text: 'The cache is pulling its weight.' },
      { below: 0.9, text: 'The cache is doing the heavy lifting.' }
    ],
    last: 'Remembering nearly everything. Show-off.'
  },
  context: {
    tiers: [
      { below: 10_000, text: 'Travelling light.' },
      { below: 60_000, text: 'A respectable amount of baggage.' },
      { below: 150_000, text: 'Carrying the whole filing cabinet.' }
    ],
    last: 'The context window is packing its bags.'
  },
  tools: {
    tiers: [
      { below: 1, text: 'No tools touched.' },
      { below: 500, text: 'Hands on, but gently.' },
      { below: 10_000, text: 'Busy hands.' }
    ],
    last: 'The toolbox is smoking.'
  },
  toolErrors: {
    tiers: [
      { below: 0.001, text: 'Flawless, or nobody checked.' },
      { below: 0.05, text: 'A few stumbles. Normal.' },
      { below: 0.15, text: 'Tools are tripping over their laces.' }
    ],
    last: 'Something keeps falling over.'
  }
}

export function captionFor(key: CaptionKey, value: number, jokes: boolean): string {
  if (!jokes) return ''
  const { tiers, last } = CAPTIONS[key]
  return pick(value, tiers, last)
}

export function summaryCaptions(summary: UsageSummary, jokes: boolean): Record<CaptionKey, string> {
  return {
    spend: captionFor('spend', summary.spendUsd, jokes),
    credits: captionFor('credits', summary.credits, jokes),
    calls: captionFor('calls', summary.calls, jokes),
    tokens: captionFor('tokens', summary.totalTokens, jokes),
    cache: captionFor('cache', summary.cacheHitRate, jokes),
    context: captionFor('context', summary.avgContextPerCall, jokes),
    tools: captionFor('tools', summary.toolCalls, jokes),
    toolErrors: captionFor('toolErrors', summary.toolErrorRate, jokes)
  }
}

/** The frustration card's headline, chosen by mean score per message. */
export function frustrationCaption(perMessage: number): string {
  return pick(
    perMessage,
    [
      { below: 0.02, text: 'Serene. Almost unnervingly so.' },
      { below: 0.15, text: 'The occasional sigh, nothing more.' },
      { below: 0.5, text: 'Voices are being raised.' }
    ],
    'Deep breaths. The keyboard is not to blame.'
  )
}
