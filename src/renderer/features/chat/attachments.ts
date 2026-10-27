// Composer attachments (spec 009): pending images and oversized-text chips held only in the
// renderer's own memory for the draft currently being composed (data-model.md "Held in memory").
// Pure types and helpers; MessageInput.tsx owns the actual state and wiring, AttachmentStrip.tsx
// and the preview modals own the presentation. `attachImageFile` (the validate-plus-commit
// sequence a pasted image and the composer's Attach button both need) moved to its own module,
// `attachImage.ts` (gate round 2, code-reviewer LOW): it needs `@/state` (`notify`,
// `useDraftStore`), and `state/draft-store.ts` imports types FROM this file, so having it here
// too made an import cycle -- harmless only because `@/state` happened to load first; any entry
// point loading this file first (a future unit test, say) would hit a load-time ReferenceError.
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

/** #926: one file or folder attached via the Attach button, drag-and-drop, or a clipboard file
 * paste. `sentAs: 'inline'` carries the exact decoded text (`text` set, `path` unset); `sentAs:
 * 'path'` (binary, over the 256 KB cap, or a folder) carries the resolved absolute path instead
 * (`path` set, `text` unset) -- `buildFileAttachmentText` embeds whichever is present into the
 * outgoing message. `byteLength` is 0 for a folder (not a meaningful count). */
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

/** A standard Chromium paste yields at most one image representation per event (research.md
 * Decision 7); an image representation always wins over a plain-text one when both are present
 * (Edge Cases) -- callers check this before ever looking at `getData('text/plain')`. */
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

/** Re-encodes anything that isn't already PNG/JPEG/GIF/WebP to PNG via an off-screen canvas
 * (FR-002; research.md Decision 7): Refract never relies on OMP's own fallback/conversion for an
 * unsupported source format. Throws on a paste that cannot even be decoded as an image (corrupt
 * data, an unsupported binary format) -- the caller turns that into the Edge Cases' inline error.
 * Low remediation: a compressed "decompression bomb" (tiny file, enormous pixel count) could
 * otherwise allocate a canvas/bitmap far larger than anything the post-re-encode size check below
 * would catch, hanging or crashing the renderer before that check ever runs. `MAX_IMAGE_PIXELS`
 * (shared/images.ts, moved there for #514/#432 so the main process's own path-based reader can
 * enforce the identical cap) is comfortably larger than any real clipboard paste while still
 * bounding worst-case canvas memory. */

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

/** Validates and, if needed, re-encodes a pasted image `File` into a `PendingImageAttachment`
 * (FR-001 to FR-003). The 20 MiB cap is checked against the blob actually about to be sent (after
 * any re-encode), never the original source's size, and Refract never attempts to shrink an
 * over-cap image to fit (FR-003) -- it is rejected outright. */
export async function buildImageAttachment(file: File): Promise<ImageAttachResult> {
  let blob: Blob = file
  let mimeType: string = file.type
  try {
    if (!isSupportedImageMimeType(mimeType)) {
      // Low remediation: reject an over-cap source file before ever decoding it -- `blob.size`
      // here is the original (possibly compressed) file, re-checked again below against the
      // final re-encoded blob's own size, since re-encoding can change it either way.
      if (blob.size > MAX_IMAGE_INPUT_BYTES) return { ok: false, reason: 'too-large', byteLength: blob.size }
      blob = await reencodeToPng(blob)
      mimeType = 'image/png'
    }
  } catch {
    return { ok: false, reason: 'decode-failed' }
  }
  if (blob.size > MAX_IMAGE_INPUT_BYTES) return { ok: false, reason: 'too-large', byteLength: blob.size }
  // Security remediation (Medium): an already-supported declared `mimeType` is never otherwise
  // decoded or byte-checked -- only its MIME string and size are. Check the real magic bytes here
  // too (the freshly re-encoded PNG branch above also passes through this harmlessly, since a
  // browser-generated PNG blob always has a real PNG signature).
  // Gate round 2 (Code2 HIGH): caught -- an uncaught rejection here (a detached/revoked blob,
  // a rare browser I/O error) used to propagate past `attachImageFile`/`attachPastedFiles`'s own
  // multi-file loop uncaught, aborting every file still queued after this one in the same paste.
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

/** FR-006: the wire-level shape sent as one entry of the outgoing command's `images` array. */
export function toImageContent(attachment: PendingImageAttachment): ImageContent {
  return { type: 'image', data: attachment.base64, mimeType: attachment.mimeType }
}

// ---------------------------------------------------------------------------
// Path-based image attachment (#514 paste-path detection, #432 drag-and-drop): both share the
// one main-process reader (`attachments.readImageFile`); this section is the renderer-side half
// -- deciding WHICH pasted/typed tokens are worth a round trip to main, and mapping the IPC
// result onto the exact same `PendingImageAttachment` shape `buildImageAttachment` produces, so
// every downstream piece (strip, remove, preview, announce) is shared, not duplicated.
// ---------------------------------------------------------------------------

// #926 gate round 1 (Code1 HIGH): exported so a clipboard-pasted `File` (no OS path at all, only
// a bare `file.name`) can be routed to the image reader purely by its own extension --
// `looksLikeImagePathToken` below REQUIRES a path separator/drive prefix/`file://` scheme before
// it even looks at the extension, so a bare name like `photo.png` (no separator) always failed
// it, silently routing every pasted image-named file to the general file reader instead.
export const IMAGE_PATH_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|avif)$/i

/** Cheap, pre-IPC heuristic only -- the real decision is always `attachments.readImageFile`'s own
 * stat + magic-byte check. This only decides which pasted/typed tokens are even worth a round
 * trip to main, so an ordinary paste containing something that merely looks slash-shaped (a
 * sentence, a code snippet) is never sent to main at all. A token is a candidate image path if it
 * has an image-shaped extension AND looks like a path: an absolute Windows drive path, a
 * `file://` URL, or any token containing a path separator (#514: "an absolute Windows path...
 * a file:/// URL... a path relative to the Session's worktree... forward-slash Windows paths"). */
export function looksLikeImagePathToken(token: string): boolean {
  if (!IMAGE_PATH_EXTENSION_RE.test(token)) return false
  if (/^file:\/\//i.test(token)) return true
  if (/^[A-Za-z]:[\\/]/.test(token)) return true
  // PR #723 gate round 3 fix (Code3 Medium, reproduced): `https://example.com/a.png` has no drive
  // prefix and is not `file://`, so it used to fall through to the slash-containing check below
  // and get treated as a path candidate -- a pointless IPC round trip that always fails (main has
  // no such local file) and re-inserts the URL text with a misleading "could not be found; left
  // as text" notice, and loses native undo in the process. Any OTHER 2-or-more-character URL
  // scheme (`https:`, `ftp:`, ...) is rejected here; a single ASCII letter followed by `:` is
  // never a URL scheme in practice, so this cannot collide with a drive letter (already handled,
  // and returned `true`, above).
  if (/^[a-z][a-z0-9+.-]+:/i.test(token)) return false
  return token.includes('/') || token.includes('\\')
}

/** A trimmed line that looks like ONE absolute path containing spaces (a screenshot tool's
 * default filename, a path copied from a terminal or editor without Explorer's own
 * auto-quoting) -- detected only when unambiguous: the line starts with a drive-letter
 * separator or a `file://` prefix AND ends with a supported image extension, with no quote
 * character anywhere on the line (a quoted/unquoted mix on the same line is the caller's own
 * quote branch's job, checked first). Lets main's own `fs.stat` be the actual authority on
 * whether the path resolves -- exactly like every other candidate -- rather than rejecting a
 * real file outright just because Explorer's own "Copy as path" quoting wasn't used this time.
 * Deliberately anchored at the START of the line (never matched inside surrounding prose): there
 * is no reliable boundary to isolate an unquoted path from prose without quotes, the same
 * reasoning `extractImagePathCandidates`'s own header comment already gives for the plain
 * whitespace-free case.
 *
 * PR #723 gate round 3 fix (Sec3/Code3 Medium, reproduced: Windows' own default screenshot
 * filenames, VS Code's "Copy Path", and ShareX all commonly produce an unquoted path containing
 * spaces): previously ANY embedded space meant "prose, not a path" -- but a path is not
 * necessarily prose just because it has a space in it, when its own shape is unambiguous end to
 * end. */
function isUnquotedSpacedPathLine(line: string): boolean {
  if (line.includes('"')) return false
  if (!IMAGE_PATH_EXTENSION_RE.test(line)) return false
  return /^[A-Za-z]:[\\/]/.test(line) || /^file:\/\//i.test(line)
}

/** Strips a surrounding pair of double quotes (Explorer's own "Copy as path" always quotes) and
 * converts a `file://` URL to a plain path string; `attachments.readImageFile`'s own path
 * validation is the authority on whether the result is actually usable.
 *
 * PR #723 gate round 1 fix (Code1 Medium): a `file://host/share/x.png` URL (a HOST-carrying
 * UNC-shaped `file:` URL, not the bare `file:///C:/...` local form) used to keep only
 * `new URL(value).pathname` (`/share/x.png`), silently DROPPING the host -- `path.isAbsolute`
 * then accepted that as a normal absolute path and main read `<current drive>:\share\x.png`, a
 * completely different local file the caller never named. A non-empty `url.host` now returns the
 * ORIGINAL, unmodified token instead: `isUnsafeToken`'s own UNC-shape check (the token still
 * contains `//host/...` after its own internal slash normalisation) then refuses it cleanly,
 * exactly as a literal `\\host\share\...` token already is. */
function normalizeImagePathToken(token: string): string {
  let value = token.trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      if (url.host !== '') return value // host-carrying file: URL -- let isUnsafeToken refuse it
      let pathname = decodeURIComponent(url.pathname)
      // A `file:///C:/...` URL's pathname keeps a leading slash before the drive letter.
      if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1)
      value = pathname
    } catch {
      // Leave `value` as the raw `file://...` string; the IPC call's own validation rejects it
      // cleanly (an unsafe/malformed token), rather than this function guessing further.
    }
  }
  return value
}

/** One candidate path as it was actually pasted/typed (`raw`) alongside the value actually sent
 * to `attachments.readImageFile` (`normalized` -- quotes stripped, a `file://` URL decoded to a
 * plain path). FR-022's own fallback text is the user's RAW pasted text, never a normalised form
 * they never typed (PR #723 gate round 3 fix, Code3 Low: the fallback used to re-insert
 * `normalized`, so a quoted path lost its quotes and a `file:///…%20…` URL came back as a
 * decoded plain path on fallback -- neither is "its own raw text", contradicting both FR-022's
 * own wording and this file's own code comment). */
export interface ImagePathCandidate {
  raw: string
  normalized: string
}

/** Splits `text` into line- and quote-separated candidate tokens (#514: "several paths, one per
 * line or separated by spaces (when each is quoted or exists)"). Deliberately never splits an
 * UNQUOTED line on spaces -- a real Windows path containing a space is always quoted by the
 * tools that produce one (Explorer's "Copy as path"), so a prose sentence that merely contains a
 * slash is never torn into nonsense fragments. Returns only tokens whose QUOTE-STRIPPED RAW form
 * (`candidateCheckToken`, see below) passes the cheap `looksLikeImagePathToken` pre-filter, each
 * with its raw AND normalized form (see `ImagePathCandidate`'s own doc comment).
 *
 * PR #723 gate round 5 fix (Code5/Sec5/A11y5 HIGH, reproduced): this filter used to run on
 * `normalized` while `isImagePathOnlyText` below ran its own equivalent check on the RAW
 * (quote-stripped only, never `file://`-decoded) token -- the two could disagree on a `file://`
 * URL carrying a `#`/`?` suffix, since `normalizeImagePathToken`'s own `new URL(...)` parse
 * treats everything from a `#` or `?` onward as a fragment/query, not part of the pathname, so a
 * `file:///C:/a#b.png` candidate lost its `.png` extension (and so got filtered OUT here) while
 * `isImagePathOnlyText` still saw `.png` at the string's own end and called the whole paste
 * path-only -- `MessageInput.tsx`'s path-only paste branch then called `preventDefault` and only
 * RE-INSERTED the candidates that actually failed to attach, so the line with the `#`/`?` token
 * silently VANISHED from the draft with no notice at all (FR-022). Both functions now run the
 * identical cheap `candidateCheckToken` (quote-strip only, no `file://` URL parse) before
 * `looksLikeImagePathToken`, so they can never again disagree on which tokens look path-shaped;
 * `normalized` itself (the `file://`-decoded form) is still what actually gets sent over IPC.
 *
 * PR #723 gate round 4 fix (Verif4 HIGH, Sec4/Code4 Medium): a QUOTED line's `raw` candidate
 * used to be the regex CAPTURE GROUP (quotes already stripped), so an unresolved "Copy as path"
 * paste (`"C:\a b\x.png"`) came back WITHOUT its own quotes on the FR-022 fallback -- the round 3
 * fix above only ever covered the `file:///%20` URL case, never the quoted-path case it was
 * supposedly fixing too. `raw` is now the FULL quoted match (quotes included).
 * PR #723 gate round 1 fix (Code1 HIGH): an UNQUOTED line containing OTHER WORDS besides a path
 * (`look at C:\x\shot.png`, `see src/a.png`) used to be pushed whole as one "candidate", since
 * `looksLikeImagePathToken` only checks the line's own END/START shape, never whether it is a
 * SINGLE token. Prose was then sent straight to the main-process reader as if it were a literal
 * path (it simply failed to resolve there, but this is "prose is never even sent to main" territory,
 * not a resolution question). Only a WHITESPACE-FREE unquoted line can be "the whole line is just
 * a path" -- any embedded space means prose, possibly ending in a path, which this function now
 * never extracts a candidate from at all (there is no reliable boundary to isolate an unquoted
 * path from surrounding prose without quotes; only a QUOTED path inside prose is ever detected,
 * see `isImagePathOnlyText`'s own mixed-line handling for the same reasoning).
 *
 * PR #723 gate round 3 fix (Sec3/Code3 Medium): an UNQUOTED line with no OTHER words, that is
 * unambiguously shaped as one absolute path end to end (`isUnquotedSpacedPathLine`), is now ALSO
 * a candidate even when it contains spaces -- the whitespace-free restriction above was always
 * about distinguishing a path from PROSE, never about rejecting a legitimate unquoted path with
 * spaces in its own name. */
/** Round 5 fix's own shared pre-filter token: strips a surrounding quote pair ONLY (never
 * `file://`-decodes, unlike `normalizeImagePathToken`) so `extractImagePathCandidates` and
 * `isImagePathOnlyText` test the identical string before `looksLikeImagePathToken` and can never
 * disagree on which tokens look path-shaped (see the round 5 fix note above). */
const candidateCheckToken = (raw: string): string => (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw)

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

/** True when `text`, once trimmed, is NOTHING BUT image-path-looking tokens (#514 point 3: the
 * path text is only ever replaced by the attachment -- never left as a label -- when there is
 * nothing else in the paste; a mixed paste always keeps its own text untouched instead).
 *
 * PR #723 gate round 1 fix (Code1/Sec1/A11y1/Verif1 HIGH, reproduced by all four reviewers): a
 * line with a QUOTED path used to check ONLY the quoted substring(s), completely ignoring every
 * other word on the line -- `please review "C:\shots\a.png" carefully` counted as "path-only" and
 * the whole sentence was silently DELETED on paste (FR-023 requires a mixed paste's text to stay
 * completely unchanged). Now requires that stripping every quoted substring from the line leaves
 * NOTHING but whitespace before treating it as path-only; otherwise the line is mixed, and
 * `isImagePathOnlyText` correctly returns `false` for the whole paste (the mixed-paste branch in
 * `MessageInput.tsx` then runs instead, leaving the text untouched and attaching in the
 * background). An unquoted line is "path-only" only when it is a single whitespace-free token,
 * OR an unambiguous unquoted-with-spaces path line (round 3 fix, same reasoning as
 * `extractImagePathCandidates` above). */
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

/** #514 point 3: a sensible bound on how many image paths ONE MESSAGE'S draft can hold at once
 * from path/drop attach, independent of the existing clipboard-image flow (which has no count
 * cap -- FR-005). Bounds the worst case of a long list of paths stalling the main-process reader.
 * Enforced per message, not per individual paste/drop (PR #723 gate round 1 fix, Code1 LOW: the
 * previous version capped only the current paste/drop's own candidate list, so several smaller
 * pastes/drops could accumulate past 10 total) -- each call site (`MessageInput.tsx`'s path-only
 * paste branch, `ChatPane.tsx`'s drop handler) computes its own REMAINING slots from the
 * session's current `attachments.images.length` before slicing its candidate list, so the total
 * across any number of pastes/drops in one draft never exceeds this. Anything past the remaining
 * slots is left as plain text (paste) or silently skipped (drop) with a quiet notice, the same
 * style as an oversized image. */
export const MAX_PATH_ATTACHMENTS_PER_MESSAGE = 10

export type ImagePathAttachFailureReason = 'not-found' | 'unsupported-type' | 'too-large'

export type ImagePathAttachResult = { ok: true; attachment: PendingImageAttachment } | { ok: false; reason: ImagePathAttachFailureReason }

/** Calls the shared main-process reader (#514/#432) and maps its `Result` onto the exact same
 * `PendingImageAttachment` shape a pasted clipboard image produces (`buildImageAttachment`
 * above), so both paths share every downstream UI piece. */
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

/** PR #723 gate round 1 fix (A11y1 LOW): a refusal notice used to drop the REASON
 * `buildImagePathAttachment` already returns -- the developer saw only "could not be attached",
 * never WHY. Maps each reason to the specific, plain-English wording FR-022/FR-026's own
 * requirement text already names ("a path that does not exist, is not an image, or is too
 * large"), for the single-failure case where one concrete reason is actually meaningful (the
 * multi-failure case still uses a plain count -- several different reasons mixed into one
 * sentence would be noise, not clarity). */
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

/** `PendingTextChip.label` (data-model.md "Rules"): the first line of the pasted text, truncated
 * to a readable length, plus a character count, with a disambiguating index appended when it
 * would otherwise collide with another pending chip's label (e.g. two pastes of the same short
 * function each producing the same label). Critical remediation: the index sits INSIDE the
 * closing `)` (`"X (900 chars, #2)"`), never appended after it (`"X (900 chars) #2"`) -- the old
 * form made every disambiguated label a literal superstring of its own base label, so a plain
 * `includes`/`indexOf` lookup for the base label (e.g. a dangling chip whose own label was never
 * disambiguated) would also match inside the longer label. Appending before the final `)` instead
 * means `base` and `base, #2` diverge at the character right after the shared prefix (`)` vs `,`),
 * so neither can ever be a literal prefix of the other, structurally, not just by convention. */
export function buildChipLabel(text: string, existingLabels: ReadonlySet<string>): string {
  // Split on CR too: a Windows clipboard uses CRLF, and the textarea rewrites a CR in the label to
  // LF, so a label carrying one would stop matching the draft after the next keystroke (#1235).
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? ''
  const truncated = firstLine.length > LABEL_FIRST_LINE_MAX ? `${firstLine.slice(0, LABEL_FIRST_LINE_MAX)}…` : firstLine
  const base = `${truncated} (${text.length} chars)`
  if (!existingLabels.has(base)) return base
  let index = 2
  while (existingLabels.has(`${truncated} (${text.length} chars, #${index})`)) index++
  return `${truncated} (${text.length} chars, #${index})`
}

/** FR-010, FR-011: over the threshold collapses to a chip; at or under it, paste exactly as
 * today. */
export function isLargePaste(text: string): boolean {
  return text.length > LARGE_PASTE_CHIP_THRESHOLD
}

export interface ChipOccurrence {
  chip: PendingTextChip
  start: number
  end: number
}

/** Critical remediation: resolves every pending chip's current position in `text` in ONE
 * left-to-right pass, instead of each chip independently looking up its own label's `indexOf`
 * (the old per-chip approach: with prefix-ambiguous labels, or any two pending labels that happen
 * to overlap at the same position -- e.g. a dangling chip's label never pruned -- an earlier
 * chip's lookup could match inside a later chip's own label, or the same text span could satisfy
 * more than one chip). Scans left to right; at each position considers every chip not yet
 * resolved, picks whichever pending label starts earliest, and breaks a same-start tie in favour
 * of the LONGEST label (the more specific match "wins" over a shorter one that happens to be a
 * literal prefix of it). Each chip is assigned at most one occurrence. `pruneDanglingChips`,
 * `substituteChips`, and `findChipOccurrences` (the overlay's own position-finding) all call this
 * one function, so all three always agree on which occurrence belongs to which chip. */
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

/** FR-014, Edge Cases: a chip is dropped the moment its label no longer appears intact in the
 * draft -- an explicit delete and an edit that breaks the label are both covered the same way,
 * since `label` is also the correlation/editing-detection key (data-model.md, research.md
 * Decision 10). Critical remediation: uses the shared `resolveChipOccurrences` pass instead of an
 * independent `includes` check per chip, so a dangling chip's label can never be kept alive by
 * coincidentally being a literal substring of another, still-live chip's label. */
export function pruneDanglingChips(text: string, chips: readonly PendingTextChip[]): PendingTextChip[] {
  const stillPending = new Set(resolveChipOccurrences(text, chips).map((occurrence) => occurrence.chip.id))
  return chips.filter((chip) => stillPending.has(chip.id))
}

/** FR-013, FR-015: substitutes every still-pending chip's full original text back into the draft
 * at its own position. Critical remediation: every chip's position is resolved together in one
 * pass first (`resolveChipOccurrences`), then substituted back-to-front (highest `start` first) --
 * replacing a later occurrence can never shift an earlier, not-yet-processed occurrence's indices,
 * so there is no risk of an earlier substitution corrupting a later chip's position the way a
 * naive left-to-right independent-lookup substitution could with overlapping/prefix labels. */
export function substituteChips(message: string, chips: readonly PendingTextChip[]): string {
  const occurrences = resolveChipOccurrences(message, chips)
  let result = message
  for (let i = occurrences.length - 1; i >= 0; i--) {
    const { chip, start, end } = occurrences[i]!
    result = result.slice(0, start) + chip.text + result.slice(end)
  }
  return result
}

/** Every pending chip's current position in `text` (research.md Decision 10: the label is the
 * correlation key), resolved via the same shared pass `pruneDanglingChips`/`substituteChips` use
 * (Critical remediation), sorted left to right for the overlay renderer below -- the loop already
 * produces occurrences in left-to-right order, since `cursor` only ever advances. */
export function findChipOccurrences(text: string, chips: readonly PendingTextChip[]): ChipOccurrence[] {
  return resolveChipOccurrences(text, chips)
}
