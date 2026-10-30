// Pure composer-attachment types and helpers. `attachImageFile` lives in `attachImage.ts`
// because it needs `@/state`, which imports types from this file (import cycle otherwise).
import type { ImageContent, SupportedImageMimeType } from '../../../shared/frames'
import {
  LARGE_PASTE_CHIP_THRESHOLD,
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_PIXELS,
  matchesImageSignature,
  SUPPORTED_IMAGE_MIME_TYPES
} from '../../../shared/images'

export interface PendingImageAttachment {
  kind: 'image'
  id: string // uuid, local only, never sent
  mimeType: SupportedImageMimeType
  base64: string // exactly the payload sent as ImageContent.data
  byteLength: number // decoded size; already checked against MAX_IMAGE_INPUT_BYTES
  previewUrl: string // `data:${mimeType};base64,${base64}`, used for the thumbnail and the modal
  name?: string // #744: display only (an image-only queue chip's label), never sent
}

export interface PendingTextChip {
  kind: 'text-chip'
  id: string // uuid, local only
  text: string // full original pasted text, byte-for-byte, never modified
  label: string // literal substring inserted into the textarea's own value at the paste position
}

/** One file or folder attached via Attach, drag-and-drop or clipboard paste; `byteLength` is 0 for a folder (#926). */
export interface PendingFileAttachment {
  kind: 'file'
  id: string // uuid, local only, never sent
  name: string
  byteLength: number
  sentAs: 'inline' | 'path'
  isDirectory: boolean
  path?: string // present only when sentAs === 'path'
  text?: string // present only when sentAs === 'inline'
}

export interface AttachmentsState {
  images: PendingImageAttachment[]
  textChips: PendingTextChip[]
  files: PendingFileAttachment[]
}

export const EMPTY_ATTACHMENTS: AttachmentsState = { images: [], textChips: [], files: [] }

function isSupportedImageMimeType(value: string): value is SupportedImageMimeType {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(value)
}

/** The pasted image file, if any; an image always wins over plain text, so check this first. */
export function findClipboardImageItem(data: DataTransfer): File | null {
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) return file
    }
  }
  return null
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

function base64FromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
}

// Re-encodes unsupported formats to PNG; throws on undecodable data. The pixel cap guards against
// decompression bombs allocating a huge canvas before the size check runs.
async function reencodeToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  try {
    if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) throw new Error('image exceeds the maximum pixel count')
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context unavailable')
    ctx.drawImage(bitmap, 0, 0)
    const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!pngBlob) throw new Error('canvas.toBlob produced no PNG blob')
    return pngBlob
  } finally {
    bitmap.close()
  }
}

function readBytePrefix(blob: Blob, length: number): Promise<Uint8Array> {
  return blob
    .slice(0, length)
    .arrayBuffer()
    .then((buffer) => new Uint8Array(buffer))
}

export type ImageAttachResult =
  | { ok: true; attachment: PendingImageAttachment }
  | { ok: false; reason: 'too-large'; byteLength: number }
  | { ok: false; reason: 'decode-failed' }

/** Validates and, if needed, re-encodes a pasted image; the size cap applies to the blob actually sent, and over-cap images are rejected, never shrunk. */
export async function buildImageAttachment(file: File): Promise<ImageAttachResult> {
  let blob: Blob = file
  let mimeType: string = file.type
  try {
    if (!isSupportedImageMimeType(mimeType)) {
      // Reject an over-cap source before decoding; re-checked below since re-encoding changes size.
      if (blob.size > MAX_IMAGE_INPUT_BYTES) return { ok: false, reason: 'too-large', byteLength: blob.size }
      blob = await reencodeToPng(blob)
      mimeType = 'image/png'
    }
  } catch {
    return { ok: false, reason: 'decode-failed' }
  }
  if (blob.size > MAX_IMAGE_INPUT_BYTES) return { ok: false, reason: 'too-large', byteLength: blob.size }
  // A declared supported mimeType is otherwise never byte-checked, so verify the magic bytes.
  // Caught so a rejected read cannot abort the remaining files in a multi-file paste.
  let signaturePrefix: Uint8Array
  try {
    signaturePrefix = await readBytePrefix(blob, 16)
  } catch {
    return { ok: false, reason: 'decode-failed' }
  }
  if (!matchesImageSignature(signaturePrefix, mimeType as SupportedImageMimeType)) {
    return { ok: false, reason: 'decode-failed' }
  }
  let dataUrl: string
  try {
    dataUrl = await readAsDataUrl(blob)
  } catch {
    return { ok: false, reason: 'decode-failed' }
  }
  const base64 = base64FromDataUrl(dataUrl)
  return {
    ok: true,
    attachment: {
      kind: 'image',
      id: crypto.randomUUID(),
      mimeType: mimeType as SupportedImageMimeType,
      base64,
      byteLength: blob.size,
      previewUrl: dataUrl,
      name: file.name || undefined
    }
  }
}

/** The wire-level shape of one entry of the outgoing `images` array. */
export function toImageContent(attachment: PendingImageAttachment): ImageContent {
  return { type: 'image', data: attachment.base64, mimeType: attachment.mimeType }
}

// Path-based image attachment (#514, #432): decides which tokens merit a round trip to the shared
// reader and maps its result onto `PendingImageAttachment`.

// Exported so a bare clipboard `file.name` (no separator) can be routed to the image reader by extension alone.
export const IMAGE_PATH_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|avif)$/i

/** Cheap pre-IPC heuristic (extension plus drive prefix, `file://` or a path separator); the real check is main's stat and magic bytes (#514). */
export function looksLikeImagePathToken(token: string): boolean {
  if (!IMAGE_PATH_EXTENSION_RE.test(token)) return false
  if (/^file:\/\//i.test(token)) return true
  if (/^[A-Za-z]:[\\/]/.test(token)) return true
  // Reject other URL schemes (`https://x/a.png`), which can never resolve locally; a single letter is a drive.
  if (/^[a-z][a-z0-9+.-]+:/i.test(token)) return false
  return token.includes('/') || token.includes('\\')
}

/** True for a line that is unambiguously one unquoted absolute image path (drive or `file://`) even with spaces; anchored at the start so prose is never matched. */
function isUnquotedSpacedPathLine(line: string): boolean {
  if (line.includes('"')) return false
  if (!IMAGE_PATH_EXTENSION_RE.test(line)) return false
  return /^[A-Za-z]:[\\/]/.test(line) || /^file:\/\//i.test(line)
}

/** Strips a surrounding double-quote pair and converts a `file://` URL to a plain path; main validates the result. */
function normalizeImagePathToken(token: string): string {
  let value = token.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      // A host-carrying (UNC-shaped) URL is returned untouched so isUnsafeToken refuses it, rather than dropping the host.
      if (url.host !== '') return value
      let pathname = decodeURIComponent(url.pathname)
      // A `file:///C:/...` URL's pathname keeps a leading slash before the drive letter.
      if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1)
      value = pathname
    } catch {
      // Leave the raw `file://...` string; the IPC call's validation rejects it.
    }
  }
  return value
}

/** A candidate as pasted (`raw`, used for the fallback text) and as sent to `attachments.readImageFile` (`normalized`). */
export interface ImagePathCandidate {
  raw: string
  normalized: string
}

// Shared pre-filter (quote-strip only, no URL parse) so extract and path-only checks cannot disagree on `#`/`?` file URLs.
const candidateCheckToken = (raw: string): string => (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw)

/** Splits `text` into candidate image paths: quoted paths, whitespace-free lines, or unambiguous unquoted spaced paths; prose is never split. */
export function extractImagePathCandidates(text: string): ImagePathCandidate[] {
  const rawCandidates: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const quoted = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[0])
    if (quoted.length > 0) {
      rawCandidates.push(...quoted)
    } else if (!/\s/.test(line)) {
      rawCandidates.push(line)
    } else if (isUnquotedSpacedPathLine(line)) {
      rawCandidates.push(line)
    }
  }
  return rawCandidates
    .map((raw) => ({ raw, normalized: normalizeImagePathToken(raw) }))
    .filter((candidate) => looksLikeImagePathToken(candidateCheckToken(candidate.raw)))
}

/** True when `text` is nothing but image-path tokens; a mixed paste must keep its text untouched (#514). */
export function isImagePathOnlyText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return false
  return lines.every((line) => {
    const quoted = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[0])
    if (quoted.length > 0) {
      if (line.replace(/"[^"]+"/g, '').trim() !== '') return false
      return quoted.every((raw) => looksLikeImagePathToken(candidateCheckToken(raw)))
    }
    if (/\s/.test(line)) return isUnquotedSpacedPathLine(line) && looksLikeImagePathToken(candidateCheckToken(line))
    return looksLikeImagePathToken(candidateCheckToken(line))
  })
}

/** Per-message cap on path/drop-attached images; call sites slice by the slots remaining in the draft (#514). */
export const MAX_PATH_ATTACHMENTS_PER_MESSAGE = 10

export type ImagePathAttachFailureReason = 'not-found' | 'unsupported-type' | 'too-large'

export type ImagePathAttachResult = { ok: true; attachment: PendingImageAttachment } | { ok: false; reason: ImagePathAttachFailureReason }

/** Reads an image by path via main (#514/#432) and maps it to the same shape a pasted image produces. */
export async function buildImagePathAttachment(sessionId: string, filePath: string): Promise<ImagePathAttachResult> {
  const result = await window.refract.attachments.readImageFile(sessionId, filePath)
  if (!result.ok) {
    const reason: ImagePathAttachFailureReason =
      result.error.code === 'image-too-large' ? 'too-large' : result.error.code === 'unsupported-image-type' ? 'unsupported-type' : 'not-found'
    return { ok: false, reason }
  }
  const { mimeType, base64, byteLength } = result.value
  return {
    ok: true,
    attachment: {
      kind: 'image',
      id: crypto.randomUUID(),
      mimeType,
      base64,
      byteLength,
      previewUrl: `data:${mimeType};base64,${base64}`,
      name: filePath.split(/[\\/]/).pop() || undefined
    }
  }
}

/** Plain-English wording for one attach-failure reason, used in single-failure notices. */
export function describeAttachFailureReason(reason: ImagePathAttachFailureReason): string {
  switch (reason) {
    case 'not-found':
      return 'could not be found'
    case 'unsupported-type':
      return 'is not a supported image type'
    case 'too-large':
      return 'is too large to attach'
  }
}

export { formatByteSize } from '@/lib/formatBytes'

const LABEL_FIRST_LINE_MAX = 40

/** Chip label: first line plus char count, with `, #n` inside the closing paren when it collides.
 * The index goes before `)` so no label is ever a literal prefix of another. */
export function buildChipLabel(text: string, existingLabels: ReadonlySet<string>): string {
  // Split on CR too: the textarea rewrites a CR to LF, which would break label matching (#1235).
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? ''
  const truncated = firstLine.length > LABEL_FIRST_LINE_MAX ? `${firstLine.slice(0, LABEL_FIRST_LINE_MAX)}…` : firstLine
  const base = `${truncated} (${text.length} chars)`
  if (!existingLabels.has(base)) return base
  let index = 2
  while (existingLabels.has(`${truncated} (${text.length} chars, #${index})`)) index++
  return `${truncated} (${text.length} chars, #${index})`
}

/** True when a paste is over the threshold and collapses to a chip. */
export function isLargePaste(text: string): boolean {
  return text.length > LARGE_PASTE_CHIP_THRESHOLD
}

export interface ChipOccurrence {
  chip: PendingTextChip
  start: number
  end: number
}

// One left-to-right pass: earliest label wins, ties go to the longest, each chip gets at most one
// occurrence, so overlapping or prefix labels cannot match the same span twice.
function resolveChipOccurrences(text: string, chips: readonly PendingTextChip[]): ChipOccurrence[] {
  const occurrences: ChipOccurrence[] = []
  const resolved = new Set<string>()
  let cursor = 0
  while (cursor <= text.length) {
    let best: { chip: PendingTextChip; start: number } | null = null
    for (const chip of chips) {
      if (resolved.has(chip.id)) continue
      const start = text.indexOf(chip.label, cursor)
      if (start === -1) continue
      if (best === null || start < best.start || (start === best.start && chip.label.length > best.chip.label.length)) {
        best = { chip, start }
      }
    }
    if (best === null) break
    resolved.add(best.chip.id)
    const end = best.start + best.chip.label.length
    occurrences.push({ chip: best.chip, start: best.start, end })
    cursor = end
  }
  return occurrences
}

/** Drops chips whose label no longer appears intact in the draft. */
export function pruneDanglingChips(text: string, chips: readonly PendingTextChip[]): PendingTextChip[] {
  const stillPending = new Set(resolveChipOccurrences(text, chips).map((occurrence) => occurrence.chip.id))
  return chips.filter((chip) => stillPending.has(chip.id))
}

/** Substitutes each pending chip's full text back into the message, back-to-front so earlier indices stay valid. */
export function substituteChips(message: string, chips: readonly PendingTextChip[]): string {
  const occurrences = resolveChipOccurrences(message, chips)
  let result = message
  for (let i = occurrences.length - 1; i >= 0; i--) {
    const { chip, start, end } = occurrences[i]!
    result = result.slice(0, start) + chip.text + result.slice(end)
  }
  return result
}

/** Every pending chip's position in `text`, left to right, for the overlay. */
export function findChipOccurrences(text: string, chips: readonly PendingTextChip[]): ChipOccurrence[] {
  return resolveChipOccurrences(text, chips)
}
