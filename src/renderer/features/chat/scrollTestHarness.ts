import type { FollowState } from './scrollFollow'
import type { SessionScrollState } from '@/state/scroll-store'
import { createTranscriptScroll, type TranscriptScroll } from './transcriptScroll'

// Vitest runs this folder in a node environment (no jsdom), so the scroller is a plain object that
// keeps the browser rules the policy depends on: `scrollTop` clamps to the scrollable range and a
// write queues one `scroll` event for the next frame. (#459, #1021)

export class FakeNode {}
// `scrollLanding` narrows event targets with `instanceof Node`, which the node environment lacks.
Object.assign(globalThis, { Node: FakeNode })

export class FakeRow extends FakeNode {
  isConnected = true
  constructor(
    private readonly viewport: FakeViewport,
    public offset: number
  ) {
    super()
  }
  getBoundingClientRect() {
    return { top: this.offset - this.viewport.scrollTop }
  }
}

const GLIDE_PX_PER_FRAME = 200

export class FakeViewport extends FakeNode {
  contentHeight: number
  clientHeight: number
  scrollEventPending = false
  readonly rows: FakeRow[] = []
  private top = 0
  private glideTarget: number | null = null
  constructor(contentHeight: number, clientHeight: number) {
    super()
    this.contentHeight = contentHeight
    this.clientHeight = clientHeight
  }
  get scrollHeight() {
    return this.contentHeight
  }
  get maxScrollTop() {
    return Math.max(0, this.contentHeight - this.clientHeight)
  }
  get scrollTop() {
    return this.top
  }
  set scrollTop(value: number) {
    const clamped = Math.min(Math.max(0, value), this.maxScrollTop)
    if (clamped === this.top) return
    this.top = clamped
    this.scrollEventPending = true
  }
  addRow(offset: number): FakeRow {
    const row = new FakeRow(this, offset)
    this.rows.push(row)
    return row
  }
  contains(node: unknown) {
    return node === this || this.rows.includes(node as FakeRow)
  }
  private readonly scrollListeners = new Set<() => void>()
  addEventListener(type: string, listener: () => void) {
    if (type === 'scroll') this.scrollListeners.add(listener)
  }
  removeEventListener(type: string, listener: () => void) {
    if (type === 'scroll') this.scrollListeners.delete(listener)
  }
  emitScroll() {
    for (const listener of [...this.scrollListeners]) listener()
  }
  closest() {
    return null
  }
  getBoundingClientRect() {
    return { top: 0, bottom: this.clientHeight }
  }
  scrollTo({ top }: { top: number; behavior: 'smooth' }) {
    this.glideTarget = top
  }
  /** Smooth scrolling covers a fixed distance per frame, like the browser's animation, and raises scroll events as it goes. */
  stepGlide() {
    if (this.glideTarget === null) return
    const next = Math.min(this.top + GLIDE_PX_PER_FRAME, this.glideTarget)
    if (next >= this.glideTarget) this.glideTarget = null
    this.scrollTop = next
  }
  get distanceFromEnd() {
    return this.scrollHeight - this.scrollTop - this.clientHeight
  }
}

type Handler = (event: { target: unknown; key?: string }) => void

/** The scroller root the settle loop listens on for user input. */
export class FakeRoot {
  private readonly handlers = new Map<string, Set<Handler>>()
  addEventListener(type: string, handler: Handler) {
    const set = this.handlers.get(type) ?? new Set<Handler>()
    set.add(handler)
    this.handlers.set(type, set)
  }
  removeEventListener(type: string, handler: Handler) {
    this.handlers.get(type)?.delete(handler)
  }
  dispatch(type: string, target: unknown, key?: string) {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler({ target, key })
  }
}

export interface FollowHarnessOptions {
  contentHeight?: number
  clientHeight?: number
  /** How the vendored scroller reacts to growth. `follows`: pins to the end while `autoScroll` is on.
   * `misses-late`: pins on streamed text but not on a late height change (Shiki, Mermaid, tool-group merge).
   * `drags-always`: pins even with `autoScroll` off, the ungated follow behind #1021. */
  library?: 'follows' | 'misses-late' | 'drags-always'
}

/** Everything a test needs to run a `Transcript`'s scroll behaviour frame by frame. */
export class FollowHarness {
  readonly viewport: FakeViewport
  readonly root = new FakeRoot()
  /** The controller `Transcript` builds through `useTranscriptScroll`: follow policy, jump control, send and Scroll to end handling. */
  readonly scroll: TranscriptScroll
  readonly recorded: SessionScrollState[] = []
  states: FollowState[] = []
  /** True while the Session's turn streams; a jump away from the end holds only then. */
  turnRunning = true
  recentGesture = false
  reducedMotion = true
  private queue: FrameRequestCallback[] = []
  private lastSize: string
  private readonly library: NonNullable<FollowHarnessOptions['library']>

  constructor(options: FollowHarnessOptions = {}) {
    this.viewport = new FakeViewport(options.contentHeight ?? 3000, options.clientHeight ?? 600)
    this.library = options.library ?? 'follows'
    this.viewport.scrollTop = this.viewport.maxScrollTop
    this.viewport.scrollEventPending = false
    this.lastSize = this.size()
    this.scroll = createTranscriptScroll({
      getViewport: () => this.viewport,
      isRecentGesture: () => this.recentGesture,
      resetGesture: () => {},
      record: (state) => this.recorded.push(state),
      prefersReducedMotion: () => this.reducedMotion,
      onChange: (state) => this.states.push(state),
      isTurnRunning: () => this.turnRunning
    })
    // A ResizeObserver reports once on observe; seeding it gives the policy its first height to compare against.
    this.scroll.follow.handleResize()
  }

  get follow() {
    return this.scroll.follow
  }

  /** The flag a landing or jump loop shares with the follow policy. */
  get landingRef() {
    return this.scroll.landingRef
  }

  private size() {
    return `${this.viewport.scrollHeight}x${this.viewport.clientHeight}`
  }

  install() {
    Object.assign(globalThis, {
      requestAnimationFrame: (callback: FrameRequestCallback) => this.queue.push(callback),
      cancelAnimationFrame: () => {}
    })
  }

  /** One browser frame: a smooth scroll advances, then the queued scroll event, animation-frame callbacks, then the resize observer. */
  frame() {
    this.viewport.stepGlide()
    if (this.viewport.scrollEventPending) {
      this.viewport.scrollEventPending = false
      this.viewport.emitScroll()
      this.follow.handleScroll()
    }
    const callbacks = this.queue
    this.queue = []
    for (const callback of callbacks) callback(0)
    const size = this.size()
    if (size !== this.lastSize) {
      this.lastSize = size
      this.follow.handleResize()
    }
  }

  frames(count: number) {
    for (let i = 0; i < count; i += 1) this.frame()
  }

  /** Streamed text grows the content; the vendored scroller follows it while `autoScroll` is on. */
  stream(px: number) {
    this.viewport.contentHeight += px
    this.libraryPin(true)
  }

  /** A height change nothing streamed: Shiki swap, Mermaid render, tool-group merge, row expand. */
  lateHeightChange(px: number) {
    this.viewport.contentHeight += px
    this.libraryPin(this.library !== 'misses-late')
  }

  /** The user clicks a row open: a gesture is in flight when the height changes, and the library follows only while attached. */
  expandRow(px: number) {
    this.recentGesture = true
    this.viewport.contentHeight += px
    this.libraryPin(true)
    this.frame()
    this.recentGesture = false
  }

  /** A panel opening or the window resizing changes the viewport height. */
  resizeViewport(clientHeight: number) {
    this.viewport.clientHeight = clientHeight
  }

  private libraryPin(active: boolean) {
    if (!active) return
    if (this.library === 'drags-always' || !this.follow.getState().suppressed) this.viewport.scrollTop = this.viewport.maxScrollTop
  }

  /** A real wheel scroll: the gesture flag the policy reads, then the position change. */
  userScrollUp(px: number) {
    this.recentGesture = true
    this.viewport.scrollTop -= px
    this.frame()
    this.recentGesture = false
  }

  userScrollDownToEnd() {
    this.recentGesture = true
    this.viewport.scrollTop = this.viewport.maxScrollTop
    this.frame()
    this.recentGesture = false
  }
}
