import { describe, expect, it } from 'vitest'
import { baseName, previewSummary, retentionPreviewData, runSummary, sweepPreviewData } from './cleanupPreview'

describe('cleanup preview shaping (SC-033)', () => {
  it('Given retention candidates, When shaped, Then every candidate is listed with its size and the total carries over', () => {
    const data = retentionPreviewData({
      enabled: true,
      days: 90,
      totalBytes: 3072,
      candidates: [
        { sessionId: 's1', file: 'C:\\logs\\one.jsonl', sizeBytes: 1024, modifiedAtMs: 0 },
        { sessionId: 's1', file: '/logs/two.jsonl', sizeBytes: 2048, modifiedAtMs: 0 }
      ]
    })
    expect(data.items.map((item) => item.label)).toEqual(['one.jsonl', 'two.jsonl'])
    expect(data.items[0]?.detail).toContain('1.0 KB')
    expect(data.totalBytes).toBe(3072)
  })

  it('Given orphan log folders, When shaped, Then each is listed by folder name with its size', () => {
    const data = sweepPreviewData({ totalBytes: 512, folders: [{ folder: '/home/u/.omp/agent/sessions/--repo--', sizeBytes: 512 }] })
    expect(data.items).toEqual([{ key: '/home/u/.omp/agent/sessions/--repo--', label: '--repo--', detail: '512 B' }])
  })

  it('Given nothing to delete, When summarised, Then it says so', () => {
    expect(previewSummary({ items: [], totalBytes: 0 }, 'Conversation')).toBe('No Conversations to delete.')
  })

  it('Given items, When summarised, Then it counts them and the bytes', () => {
    const data = { items: [{ key: 'a', label: 'a', detail: '' }], totalBytes: 2048 }
    expect(previewSummary(data, 'log folder')).toBe('1 log folder, 2.0 KB in total.')
  })

  it('Given a run with failures, When reported, Then the freed space and the failures are both named', () => {
    expect(runSummary({ deleted: 2, failed: 1, bytesFreed: 1024 }, 'Conversation')).toBe('Deleted 2 Conversations. Freed 1.0 KB. 1 could not be deleted.')
    expect(runSummary({ deleted: 1, failed: 0, bytesFreed: 0 }, 'Conversation')).toBe('Deleted 1 Conversation. Freed 0 B.')
  })

  it('Given a path with trailing separators, When its base name is taken, Then the last segment returns', () => {
    expect(baseName('a/b/')).toBe('b')
  })
})
