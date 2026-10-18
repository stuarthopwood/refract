// Any-file attachment (#926): "attach any file type, inlining text files up to 256 KB and
// sending other files as a path". Split out of `attachments.ts` (gate convention, `attachImage.ts`
// /`attachDroppedPaths.ts`'s own precedent): keeps that file under the `check:file-size` soft cap
// rather than letting it grow into a second god file. Anything routed through the Attach button's
// native picker or drag-and-drop shares the SAME path-resolution/symlink-safety reader as the
// image path (`attachments.readFile`, the new sibling of `readImageFile`); a clipboard-pasted
// FILE with no resolvable OS path (Tauri's `File` API never exposes one) is handled separately
// below, client-side, since there is no path to send main for that case at all.
import type { ImagePathAttachFailureReason, PendingFileAttachment, PendingImageAttachment } from './attachments'
import { buildImagePathAttachment, looksLikeImagePathToken } from './attachments'

/** The sentinel line `transcript.rs`'s own `extract_file_attachments` looks for to find and
 * strip the appended attachment section from a message's displayed text -- never shown to the
 * developer, never sent as an instruction to the agent beyond being part of the plain message
 * string every other line of this section already is. */
export const FILE_ATTACHMENTS_MARKER = '[[refract-attachments]]'

/** #926 grill decision 2/3: matches `src-tauri/src/ipc/attachments.rs`'s own
 * `MAX_INLINE_FILE_BYTES` -- a text file up to this many bytes inlines verbatim; anything larger
 * is sent as its own path instead. Duplicated here (never shared across the IPC boundary) only
 * for the renderer-only clipboard-file-paste path below, which never crosses into Rust at all. */
export const MAX_INLINE_FILE_BYTES = 256 * 1024
const BINARY_SNIFF_PREFIX_BYTES = 8 * 1024

export type FileAttachFailureReason = 'not-found' | 'too-large' | 'read-failed'

export type FilePathAttachResult = { ok: true; attachment: PendingFileAttachment } | { ok: false; reason: FileAttachFailureReason }

/** Calls the shared main-process reader (#926) and maps its `Result` onto `PendingFileAttachment`. */
export async function buildFilePathAttachment(sessionId: string, filePath: string): Promise<FilePathAttachResult> {
  const result = await window.refract.attachments.readFile(sessionId, filePath)
  if (!result.ok) {
    const reason: FileAttachFailureReason = result.error.code === 'not-found' ? 'not-found' : 'read-failed'
    return { ok: false, reason }
  }
  const value = result.value
  if (value.kind === 'inline') {
    return {
      ok: true,
      attachment: {
        kind: 'file',
        id: crypto.randomUUID(),
        name: value.name,
        byteLength: value.byteLength,
        sentAs: 'inline',
        isDirectory: false,
        text: value.text
      }
    }
  }
  return {
    ok: true,
    attachment: {
      kind: 'file',
      id: crypto.randomUUID(),
      name: value.name,
      byteLength: value.byteLength,
      sentAs: 'path',
      isDirectory: value.isDirectory,
      path: value.path
    }
  }
}

export type AnyPathAttachResult =
  | { ok: true; kind: 'image'; attachment: PendingImageAttachment }
  | { ok: true; kind: 'file'; attachment: PendingFileAttachment }
  | { ok: false; reason: ImagePathAttachFailureReason | FileAttachFailureReason }

/** #926: the Attach button's native multi-file picker and drag-and-drop both route every
 * resolved path through here. A supported image (by extension -- the same cheap pre-IPC
 * heuristic `looksLikeImagePathToken` already uses for #514's path detection) goes through the
 * EXISTING, independently-revalidated image reader unchanged (#926's own "images still go to
 * omp as images" decision); anything else -- including a corrupt/oversized file that merely
 * LOOKS like an image by extension -- falls back to the general file reader, which classifies it
 * as inline text or a path/folder attachment. */
export async function buildAnyPathAttachment(sessionId: string, filePath: string, baseName: string): Promise<AnyPathAttachResult> {
  if (looksLikeImagePathToken(baseName)) {
    const imageResult = await buildImagePathAttachment(sessionId, filePath)
    if (imageResult.ok) return { ok: true, kind: 'image', attachment: imageResult.attachment }
    if (imageResult.reason === 'not-found') return { ok: false, reason: 'not-found' }
    // 'too-large' or 'unsupported-type' (an image-extensioned file that is not actually a
    // recognised image, or is too large for the image cap) -- fall through to the general reader.
  }
  const fileResult = await buildFilePathAttachment(sessionId, filePath)
  if (fileResult.ok) return { ok: true, kind: 'file', attachment: fileResult.attachment }
  return { ok: false, reason: fileResult.reason }
}

export function describeFileAttachFailureReason(reason: FileAttachFailureReason): string {
  switch (reason) {
    case 'not-found':
      return 'could not be found'
    case 'too-large':
      return 'is too large to attach'
    case 'read-failed':
      return 'could not be read'
  }
}

/** #926: `buildAnyPathAttachment`'s own reason type spans both the image and the general-file
 * failure vocabularies (`not-found`/`too-large` are shared; `unsupported-type` is image-only,
 * `read-failed` file-only) -- one wording table so a caller attaching a mix of images and other
 * files never needs to know which vocabulary a given failure came from. */
export function describeAnyAttachFailureReason(reason: ImagePathAttachFailureReason | FileAttachFailureReason): string {
  switch (reason) {
    case 'not-found':
      return 'could not be found'
    case 'unsupported-type':
      return 'is not a supported image type'
    case 'too-large':
      return 'is too large to attach'
    case 'read-failed':
      return 'could not be read'
  }
}

export type PastedFileAttachResult = { ok: true; attachment: PendingFileAttachment } | { ok: false; reason: 'too-large' | 'binary' }

/** #926: a clipboard-pasted FILE (Explorer "Copy" a file, then paste) that is not an image.
 * Tauri's `File` API exposes no OS path for a pasted file (unlike a native drag-drop or the
 * Attach dialog, both of which hand over real paths) -- so this reads the bytes directly in the
 * renderer, the same trust level `buildImageAttachment`'s own clipboard-image read already uses
 * (the user's own clipboard content, not an attacker-controlled path), and can only ever produce
 * an INLINE attachment: a binary or over-cap pasted file has no path to fall back to, so it is a
 * clear, named error instead -- the developer is told to use the Attach button or drag-and-drop
 * instead, both of which DO resolve a real path. */
export async function buildPastedFileAttachment(file: File): Promise<PastedFileAttachResult> {
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength > MAX_INLINE_FILE_BYTES) return { ok: false, reason: 'too-large' }
  const bytes = new Uint8Array(buffer)
  const sniffLength = Math.min(bytes.length, BINARY_SNIFF_PREFIX_BYTES)
  if (bytes.subarray(0, sniffLength).includes(0)) return { ok: false, reason: 'binary' }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, reason: 'binary' }
  }
  return {
    ok: true,
    attachment: { kind: 'file', id: crypto.randomUUID(), name: file.name, byteLength: bytes.length, sentAs: 'inline', isDirectory: false, text }
  }
}

/** #926: builds the exact text `transcript.rs`'s own `extract_file_attachments` parses back out
 * of the plain message, so the user's bubble can show a chip instead of a 256 KB wall of text.
 * Each inline file becomes a fenced block (info string: the file name) preceded by a fixed,
 * non-instructional lead-in line (Stuart's own comment on #926: an inlined file is untrusted
 * data, never parsed or acted on by Refract itself); each path-sent file or folder becomes one
 * line naming its own resolved absolute path, for the agent to read with its own tools. Returns
 * '' for an empty list -- the caller never appends anything in that case. Never includes the
 * leading blank-line separator from any preceding typed text; the caller joins that itself only
 * when there is some. */
export function buildFileAttachmentText(files: readonly PendingFileAttachment[]): string {
  if (files.length === 0) return ''
  const blocks = files.map((file) => {
    if (file.sentAs === 'inline') {
      const content = file.text ?? ''
      // The longest run of consecutive backticks anywhere in `content`, the same technique
      // `Markdown.tsx`'s own advisor-note quoting (#558) uses: the fence below is always one
      // longer, so the content can never contain a run that could close it early.
      const longestBacktickRun = (content.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
      const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1))
      return `Attached file "${file.name}" (${file.byteLength} bytes, inlined below):\n${fence}${file.name}\n${content}\n${fence}`
    }
    if (file.isDirectory) {
      return `Attached folder "${file.name}" (sent as path, read with your own tools): ${file.path ?? ''}`
    }
    return `Attached file "${file.name}" (${file.byteLength} bytes, sent as path, read with your own tools): ${file.path ?? ''}`
  })
  return `${FILE_ATTACHMENTS_MARKER}\n${blocks.join('\n\n')}`
}

/** #926: joins the developer's own typed/substituted message with `buildFileAttachmentText`'s
 * output, if any -- a blank-line separator only when there is some typed text to separate it
 * from (an attachment-only draft, once #744 allows one, never starts with stray blank lines). */
export function appendFileAttachmentText(message: string, files: readonly PendingFileAttachment[]): string {
  const attachmentText = buildFileAttachmentText(files)
  if (attachmentText === '') return message
  return message.length > 0 ? `${message}\n\n${attachmentText}` : attachmentText
}
