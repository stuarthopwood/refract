import type { ImageContent } from './frames';

/** Spec 030 (#517): what `chat.stop` returns -- the queued messages OMP withdrew. */
export interface StopResult {
  messages: { text: string; images: ImageContent[] }[];
  /** OMP omitted every image because the full result exceeded its transport limit. */
  imagesDropped: boolean;
  /** OMP listed only an oldest-first prefix of the queue. */
  truncated: boolean;
}
