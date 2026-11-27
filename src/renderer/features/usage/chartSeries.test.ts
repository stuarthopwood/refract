import { describe, expect, it } from 'vitest'
import { moodSparkline, spendSparkline } from './chartSeries'
import { formatBucketLabel } from './format'

// Local noon, so the day label is the same in any time zone.
const day = (d: number): number => new Date(2026, 10, d, 12).getTime()
const buckets = [
  { bucketStart: day(3), byModel: [{ model: 'opus', usd: 1.2, credits: 0 }, { model: 'sonnet', usd: 0.3, credits: 0 }] },
  { bucketStart: day(4), byModel: [{ model: 'opus', usd: 2, credits: 0 }] }
]

describe('spendSparkline', () => {
  it('feeds_total_spend_per_bucket_in_order', () => {
    expect(spendSparkline(buckets, 'day').values).toEqual([1.5, 2])
  })

  it('heads_each_point_with_its_own_day_label', () => {
    expect(spendSparkline(buckets, 'day').labels).toEqual([formatBucketLabel(day(3), 'day'), formatBucketLabel(day(4), 'day')])
  })

  it('heads_points_with_hour_labels_for_the_hour_bucket', () => {
    const { labels } = spendSparkline(buckets, 'hour')

    expect(labels).toEqual([formatBucketLabel(day(3), 'hour'), formatBucketLabel(day(4), 'hour')])
    expect(labels).not.toEqual(spendSparkline(buckets, 'day').labels)
  })

  it('is_empty_without_buckets', () => {
    expect(spendSparkline([], 'day')).toEqual({ values: [], labels: [] })
  })
})

describe('moodSparkline', () => {
  const daily = [
    { day: '2026-11-03', mood: 0.5 },
    { day: '2026-11-04', mood: 1.25 }
  ]

  it('feeds_the_daily_mood_headed_by_its_day', () => {
    expect(moodSparkline(daily)).toEqual({ values: [0.5, 1.25], labels: ['2026-11-03', '2026-11-04'] })
  })
})
