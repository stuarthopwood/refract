/** Blur filter put on content that sits behind a notice or card (`LoadingOverlay`, the chat Starting agent notice). The notice is a sibling, so it stays sharp. */
export const BLURRED_CONTENT_CLASS = 'blur-sm'

/** Animates the blur in and out; with reduced motion on, it appears and clears at once. */
export const BLUR_TRANSITION_CLASS = 'transition-[filter] duration-150 motion-reduce:transition-none'
