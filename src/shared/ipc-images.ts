// #513: contract for showing a user message's images in the chat bubble.

import type { Result } from './ipc'

/** An image sent with a user message. Carries an id only; the bytes load on demand via `images.get`. */
export interface TranscriptImageRef {
  /** Blob hash, content id of a live inline image, or `invalid` when the bytes were unusable. */
  id: string
  mimeType: string
  byteLength?: number
  width?: number
  height?: number
}

export interface MessageImageData {
  /** `data:` URL (the CSP allows `data:` images, not `blob:`). */
  dataUrl: string
  mimeType: string
  byteLength: number
  width: number
  height: number
}

export interface ImagesApi {
  images: {
    /** Fails with `not-found` when the image is gone or the id is not valid. */
    get: (imageId: string) => Promise<Result<MessageImageData>>
  }
}
