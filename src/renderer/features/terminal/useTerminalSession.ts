import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { ITerminalOptions, Terminal } from '@xterm/xterm'
import { useActiveThemeId } from '@/state/theme-store'
import { useTypographyStore } from '@/state/typography-store'
import { ACK_EVERY_BYTES, INPUT_MAX_BYTES } from '../../../shared/terminalLimits'
import { FRAME_TAG_DATA } from '../../../shared/ipc-terminal'
import type { TabState, TerminalApi } from '../../../shared/ipc-terminal'
import { toast } from 'sonner'
import { openInBrowser } from '@/lib/openInBrowser'
import { isMotionReduced, subscribeOsReducedMotion } from '@/lib/reducedMotion'
import { accessOptions } from './terminalOptions'
import { readTerminalTheme } from './terminalTheme'
import { opensContextMenu } from './terminalKeyboard'

// One live xterm instance shows the active tab. Rust owns the shell and keeps the last 2 MiB; switching tab, Panel or
// Session detaches and re-attaches, and the ring replay rebuilds the screen (spec 144 FR-008). Nothing here closes a tab.

/** Lines the view keeps above the screen. The authoritative scrollback is Rust's ring; this is only the visible cache. */
export const VIEW_SCROLLBACK_LINES = 5000
/** Resizes reach the shell once the pane stops moving, so a drag sends one `terminal.resize`, not hundreds. */
export const RESIZE_DEBOUNCE_MS = 100
/** A UTF-8 character is at most 4 bytes, so this many UTF-16 units always fit one `terminal.input` call. */
const INPUT_CHUNK_UNITS = INPUT_MAX_BYTES / 4

/** What the link needs of an xterm `Terminal`; a fake stands in for it in tests. */
export interface TerminalSurface {
  readonly cols: number
  readonly rows: number
  write(data: Uint8Array, callback?: () => void): void
  reset(): void
}

export type TerminalBridge = Pick<TerminalApi, 'attach' | 'detach' | 'input' | 'resize' | 'ack'>

export type AttachOutcome = { kind: 'attached'; state: TabState } | { kind: 'failed'; message: string } | { kind: 'superseded' }

export interface TerminalLink {
  /** Shows `tabId`: detaches the tab shown before, clears the screen, attaches and lets the ring replay fill it. */
  attach(sessionId: string, tabId: string): Promise<AttachOutcome>
  /** Stops showing the current tab. The shell keeps running. */
  detach(): void
  /** Sends typed or pasted text to the shown tab, in order, split to the per-call limit. */
  sendInput(data: string): void
  /** Fits the view to its container now and tells the shell the new size once it settles. */
  requestFit(): void
  dispose(): void
}

function chunkInput(data: string): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < data.length) {
    let end = Math.min(start + INPUT_CHUNK_UNITS, data.length)
    // Never cut a surrogate pair: each half alone is an invalid character on the Rust side.
    const last = data.charCodeAt(end - 1)
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1
    chunks.push(data.slice(start, end))
    start = end
  }
  return chunks
}

export function createTerminalLink(
  bridge: TerminalBridge,
  surface: TerminalSurface,
  fit: () => void,
  debounceMs = RESIZE_DEBOUNCE_MS,
  onInputError: (message: string) => void = (message) => toast.error(`The terminal did not take your input: ${message}`)
): TerminalLink {
  let shown: string | null = null
  let generation = 0
  let unacked = 0
  let sentSize = ''
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  let inputChain: Promise<unknown> = Promise.resolve()

  const sendChunk = async (tabId: string, chunk: string, batch: { failed: boolean }): Promise<void> => {
    if (batch.failed) return
    let message: string | null = null
    try {
      const result = await bridge.input(tabId, chunk)
      if (!result.ok) message = result.error.message
    } catch (error) {
      message = error instanceof Error ? error.message : 'The terminal did not answer'
    }
    if (message === null) return
    batch.failed = true
    onInputError(message)
  }

  const sizeKey = (): string => `${surface.cols}x${surface.rows}`

  const release = (): void => {
    if (shown !== null) void bridge.detach(shown)
    shown = null
  }

  const onFrame = (frameGeneration: number, tabId: string, frame: ArrayBuffer): void => {
    // A frame from an attach that has since been replaced belongs to a screen that no longer exists.
    if (frameGeneration !== generation) return
    const view = new Uint8Array(frame)
    if (view[0] !== FRAME_TAG_DATA || view.length < 2) return
    const payload = view.subarray(1)
    // Ack from the write callback, not on arrival: the reader only pauses while xterm is genuinely behind (SC-003).
    surface.write(payload, () => {
      if (frameGeneration !== generation) return
      unacked += payload.length
      if (unacked < ACK_EVERY_BYTES) return
      const bytes = unacked
      unacked = 0
      void bridge.ack(tabId, bytes)
    })
  }

  return {
    async attach(sessionId, tabId) {
      if (shown !== null && shown !== tabId) release()
      const mine = ++generation
      shown = tabId
      unacked = 0
      surface.reset()
      const result = await bridge.attach(sessionId, tabId, surface.cols, surface.rows, (frame) => onFrame(mine, tabId, frame))
      if (mine !== generation) {
        // The tab we were attaching was replaced while the request was in flight; free its sink unless it is the one now shown.
        if (result.ok && shown !== tabId) void bridge.detach(tabId)
        return { kind: 'superseded' }
      }
      if (!result.ok) {
        shown = null
        return { kind: 'failed', message: result.error.message }
      }
      sentSize = sizeKey()
      return { kind: 'attached', state: result.value.state }
    },

    detach() {
      generation += 1
      release()
    },

    sendInput(data) {
      const tabId = shown
      if (tabId === null) return
      // One paste is one batch: after the first chunk the shell refuses, the rest would land as a corrupt half-paste.
      const batch = { failed: false }
      for (const chunk of chunkInput(data)) {
        // Keystrokes must reach the shell in order; a rejected call must not wedge the ones behind it.
        inputChain = inputChain.then(() => sendChunk(tabId, chunk, batch))
      }
    },

    requestFit() {
      fit()
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined
        const tabId = shown
        if (tabId === null || surface.cols < 1 || surface.rows < 1 || sizeKey() === sentSize) return
        sentSize = sizeKey()
        void bridge.resize(tabId, surface.cols, surface.rows)
      }, debounceMs)
    },

    dispose() {
      clearTimeout(resizeTimer)
      generation += 1
      release()
    }
  }
}

export type TerminalSessionStatus = 'starting' | 'attached' | 'failed'

export interface TerminalSessionHandle {
  containerRef: RefObject<HTMLDivElement | null>
  status: TerminalSessionStatus
  /** The attach failure the panel shows; `null` otherwise. Never terminal content. */
  message: string | null
  focus(): void
  /** The text selected in the view, or an empty string. */
  getSelection(): string
}

function readFont(): Pick<ITerminalOptions, 'fontFamily' | 'fontSize'> {
  const root = getComputedStyle(document.documentElement)
  const scale = Number.parseFloat(root.getPropertyValue('--scale-code')) || 1
  return { fontFamily: root.getPropertyValue('--font-code').trim() || 'monospace', fontSize: Math.round(13 * scale) }
}

interface Runtime {
  term: Terminal
  link: TerminalLink
}

/**
 * Mounts one xterm view in `containerRef` and keeps it attached to `tabId`. `reattachToken` forces a fresh attach for
 * the same tab (a restarted shell has an empty ring). xterm loads lazily: the panel is optional, the library is large.
 */
export function useTerminalSession(sessionId: string, tabId: string | null, reattachToken: number): TerminalSessionHandle {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const runtime = useRef<Runtime | null>(null)
  const [ready, setReady] = useState(false)
  const [outcome, setOutcome] = useState<{ status: TerminalSessionStatus; message: string | null }>({ status: 'starting', message: null })
  const themeId = useActiveThemeId()
  const codeScale = useTypographyStore((s) => s.typography.codeScale)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let cancelled = false
    let teardown: () => void = () => undefined
    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/xterm/css/xterm.css')
      ])
      if (cancelled) return
      // OSC 8 links the shell prints open through the app's own external-link policy, not xterm's window.open default.
      const linkHandler = { activate: (_event: MouseEvent, uri: string) => openInBrowser(uri) }
      // Bracketed paste is left at xterm's default (on): a multi-line paste reaches the shell as one paste, not as typed lines.
      const term = new XTerm({ scrollback: VIEW_SCROLLBACK_LINES, ...accessOptions(isMotionReduced()), linkHandler, theme: readTerminalTheme(), ...readFont() })
      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(container)
      // Shift+F10 and the Menu key must reach the browser so the keyboard can open the context menu.
      term.attachCustomKeyEventHandler((event) => !opensContextMenu(event))
      fitAddon.fit()
      const link = createTerminalLink(window.refract.terminal, term, () => fitAddon.fit())
      const typing = term.onData((data) => link.sendInput(data))
      const observer = new ResizeObserver(() => link.requestFit())
      observer.observe(container)
      runtime.current = { term, link }
      teardown = () => {
        observer.disconnect()
        typing.dispose()
        link.dispose()
        term.dispose()
        runtime.current = null
      }
      setReady(true)
    })()
    return () => {
      cancelled = true
      teardown()
      setReady(false)
    }
  }, [])

  useEffect(() => {
    if (!ready || tabId === null) return
    const current = runtime.current
    if (!current) return
    setOutcome({ status: 'starting', message: null })
    void current.link.attach(sessionId, tabId).then((result) => {
      if (result.kind === 'attached') setOutcome({ status: 'attached', message: null })
      else if (result.kind === 'failed') setOutcome({ status: 'failed', message: result.message })
    })
    // Leaving this tab (switch, Panel or Session change, unmount) detaches; the shell keeps running in Rust.
    return () => current.link.detach()
  }, [ready, sessionId, tabId, reattachToken])

  useEffect(() => {
    if (!ready) return
    // The new theme's CSS lands on the next frame; read the tokens after it.
    const frame = requestAnimationFrame(() => {
      if (runtime.current) runtime.current.term.options.theme = readTerminalTheme()
    })
    return () => cancelAnimationFrame(frame)
  }, [ready, themeId])

  // The OS setting can change while a terminal is open; the app's own Reduce motion switch still counts after it.
  useEffect(() => {
    if (!ready) return
    return subscribeOsReducedMotion(() => {
      if (runtime.current) runtime.current.term.options.cursorBlink = !isMotionReduced()
    })
  }, [ready])

  useEffect(() => {
    const current = runtime.current
    if (!ready || !current) return
    current.term.options.fontSize = readFont().fontSize
    current.link.requestFit()
  }, [ready, codeScale])

  const focus = useCallback(() => runtime.current?.term.focus(), [])
  const getSelection = useCallback(() => runtime.current?.term.getSelection() ?? '', [])
  return { containerRef, status: outcome.status, message: outcome.message, focus, getSelection }
}
