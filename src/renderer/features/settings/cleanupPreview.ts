// Shapes the Rust previews and run results of the two opt-in cleanups (#2161: old Conversations, FR-189;
// orphan OMP log folders, FR-190) into one list the shared preview dialog renders.
import { formatByteSize } from '@/lib/formatBytes'
import type { RetentionPreview, SessionLogsSweepPreview } from '../../../shared/model'

export interface CleanupItem {
  key: string
  label: string
  detail: string
}

export interface CleanupPreviewData {
  items: CleanupItem[]
  totalBytes: number
}

export interface CleanupRunData {
  deleted: number
  failed: number
  bytesFreed: number
}

/** The last path segment, for either separator. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export function retentionPreviewData(preview: RetentionPreview): CleanupPreviewData {
  return {
    totalBytes: preview.totalBytes,
    items: preview.candidates.map((candidate) => ({
      key: candidate.file,
      label: baseName(candidate.file),
      detail: `${formatByteSize(candidate.sizeBytes)} · last changed ${new Date(candidate.modifiedAtMs).toLocaleDateString()}`
    }))
  }
}

export function sweepPreviewData(preview: SessionLogsSweepPreview): CleanupPreviewData {
  return {
    totalBytes: preview.totalBytes,
    items: preview.folders.map((folder) => ({ key: folder.folder, label: baseName(folder.folder), detail: formatByteSize(folder.sizeBytes) }))
  }
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

export function previewSummary(data: CleanupPreviewData, noun: string): string {
  return data.items.length === 0 ? `No ${noun}s to delete.` : `${plural(data.items.length, noun)}, ${formatByteSize(data.totalBytes)} in total.`
}

export function runSummary(run: CleanupRunData, noun: string): string {
  const freed = `Deleted ${plural(run.deleted, noun)}. Freed ${formatByteSize(run.bytesFreed)}.`
  return run.failed > 0 ? `${freed} ${run.failed} could not be deleted.` : freed
}
