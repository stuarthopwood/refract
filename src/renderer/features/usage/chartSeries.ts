// The values and tooltip headings each Usage sparkline is fed, kept pure so the heading shown for
// each point is tested (#1882) rather than left to a render.
import type { UsageFrustration, UsageTimeBucket } from '../../../shared/ipc-usage'
import { formatBucketLabel } from './format'

interface SparklineSeries {
  values: number[]
  labels: string[]
}

/** Total spend per bucket, headed by the bucket's own day or hour label. */
export function spendSparkline(buckets: UsageTimeBucket[], bucket: 'day' | 'hour'): SparklineSeries {
  return {
    values: buckets.map((b) => b.byModel.reduce((sum, m) => sum + m.usd, 0)),
    labels: buckets.map((b) => formatBucketLabel(b.bucketStart, bucket))
  }
}

/** The daily mood score, headed by its day. */
export function moodSparkline(daily: UsageFrustration['daily']): SparklineSeries {
  return { values: daily.map((d) => d.mood), labels: daily.map((d) => d.day) }
}
