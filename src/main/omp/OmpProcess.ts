// Drives one `omp --mode rpc-ui` child process for a single Session's worktree.
// Wire contract: specs/001-core-session-workspace/contracts/omp-usage.md ("Launch",
// "Start-up sequence", "Frames Pinion consumes", "Commands Pinion sends"). Frame and
// command shapes: src/shared/frames.ts.
//
// Events:
//   'frame' (Frame)  every decoded frame except `response` frames, which are consumed
//                     internally by request() and never emitted (constitution: one way
//                     to read a response).
//   'exit'  ({ code: number | null; requested: boolean })  fires exactly once.

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { type ApprovalMode, OMP_APPROVAL_MODE } from '../../shared/model'
import type { Frame, ReadyFrame, ResponseFrame, RpcChunkFrame, RpcCommand } from '../../shared/frames'
import { recordProcess, removeProcessRecord } from '../process/pidRecords'

const READY_TIMEOUT_MS = 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const STOP_GRACE_MS = 10_000
const STDERR_TAIL_BYTES = 4 * 1024
const STDERR_FAILURE_TAIL_BYTES = 2 * 1024
// FINDINGS C22b: v1 frames are capped at maxFrameBytes; a reassembled rpc_chunk sequence
// above this ceiling is treated as corrupt rather than buffered without bound.
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024

export interface OmpProcessOptions {
  cwd: string
  approvalMode: ApprovalMode
  resumeFile?: string
  sessionId: string
  ompPath?: string
}

interface PendingRequestEntry {
  resolve: (frame: ResponseFrame) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface ChunkAssembly {
  parts: Array<Buffer | undefined>
  got: number
  byteLength: number
}

export class OmpProcess extends EventEmitter {
  private readonly opts: OmpProcessOptions
  private child: ChildProcessWithoutNullStreams | undefined
  private stdoutBuf: Buffer = Buffer.alloc(0)
  private stderrBuf: Buffer = Buffer.alloc(0)
  private readonly chunks = new Map<string, ChunkAssembly>()
  private readonly pending = new Map<string, PendingRequestEntry>()
  private requestCounter = 0
  private requested = false
  private exited = false
  private exitEmitted = false
  private exitWaiters: Array<() => void> = []
  private stopPromise: Promise<void> | undefined
  private lastSpawnError: NodeJS.ErrnoException | undefined

  constructor(opts: OmpProcessOptions) {
    super()
    this.opts = opts
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  get stderrTail(): string {
    return this.stderrBuf.toString('utf8')
  }

  /** Spawns `omp` and resolves once the ready handshake (and v2 negotiation) completes. */
  async start(): Promise<void> {
    if (this.child) {
      throw new Error('OmpProcess: start() already called')
    }

    const ompPath = this.opts.ompPath ?? 'omp'
    const args: string[] = ['--mode', 'rpc-ui', `--approval-mode=${OMP_APPROVAL_MODE[this.opts.approvalMode]}`]
    if (this.opts.resumeFile) {
      args.push('--resume', this.opts.resumeFile)
    }

    // stdio omitted: the default ('pipe' for all three streams) is exactly what the
    // contract asks for, and omitting it lets TypeScript pick the
    // ChildProcessWithoutNullStreams overload instead of the nullable-stream one.
    const child = spawn(ompPath, args, {
      cwd: this.opts.cwd,
      windowsHide: true,
    })
    this.child = child

    child.on('error', (err: NodeJS.ErrnoException) => {
      this.lastSpawnError = err
      console.error('OmpProcess: child process error', err)
    })
    child.stdout.on('data', (chunk: Buffer) => this.onStdoutData(chunk))
    child.stderr.on('data', (chunk: Buffer) => this.onStderrData(chunk))
    child.on('exit', (code) => this.onExit(code))

    // Record the pid immediately after spawn returns, before wiring anything else that
    // could throw; Job Object membership is inherited, so this pid record is the fallback
    // protection if that job is ever lost.
    if (typeof child.pid === 'number') {
      recordProcess(child.pid, this.opts.sessionId).catch((err: unknown) => {
        console.error('OmpProcess: recordProcess failed', err)
      })
    }

    // Promise.withResolvers() would read cleaner here, but it needs lib "ES2024" and
    // tsconfig.node.json is pinned to "ES2023" (owned by another task); executor form kept.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(this.buildStartFailure(`ready frame not seen within ${READY_TIMEOUT_MS / 1000}s`))
      }, READY_TIMEOUT_MS)

      const cleanup = (): void => {
        clearTimeout(timer)
        this.off('frame', onFrame)
        this.off('exit', onExitDuringStart)
        child.off('error', onSpawnErrorDuringStart)
      }

      const onExitDuringStart = (info: { code: number | null; requested: boolean }): void => {
        cleanup()
        reject(this.buildStartFailure(`process exited before ready (code ${String(info.code)})`))
      }
      this.once('exit', onExitDuringStart)

      // A spawn failure (e.g. ENOENT) does not reliably produce a child 'exit' event, so
      // fail fast here instead of waiting out the full ready timeout.
      const onSpawnErrorDuringStart = (err: NodeJS.ErrnoException): void => {
        cleanup()
        reject(this.buildStartFailure(`process failed to spawn: ${err.message}`))
      }
      child.once('error', onSpawnErrorDuringStart)

      const onFrame = (frame: Frame): void => {
        if (frame.type !== 'ready') return
        cleanup()
        // `type` narrowing alone can't isolate ReadyFrame from the Frame union because
        // UnknownFrame's index signature accepts any key; the check above already
        // confirmed this is a ready frame.
        const ready = frame as ReadyFrame
        void (async () => {
          try {
            if (ready.supportedProtocolVersions.includes(2)) {
              const res = await this.request({ type: 'negotiate_protocol', id: '', protocolVersion: 2 })
              if (!res.success) {
                throw new Error(`negotiate_protocol failed: ${res.error ?? 'unknown error'}`)
              }
            }
            resolve()
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })()
      }
      this.on('frame', onFrame)
    })
  }

  /** Writes one JSON object to stdin as a newline-delimited frame. */
  write(obj: object): void {
    if (!this.child) {
      throw new Error('OmpProcess: start() must be called before write()')
    }
    this.child.stdin.write(JSON.stringify(obj) + '\n')
  }

  /** Sends `cmd` with a fresh unique id and resolves on the matching `response` frame. */
  async request(cmd: RpcCommand, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<ResponseFrame> {
    if (!this.child) {
      throw new Error('OmpProcess: start() must be called before request()')
    }
    if (this.exited) {
      throw new Error('OmpProcess: process has exited')
    }
    const id = `pinion-${++this.requestCounter}`
    const withId: RpcCommand = { ...cmd, id }

    // Executor form: see start() for why Promise.withResolvers() isn't available here.
    return new Promise<ResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`OmpProcess: request timed out after ${timeoutMs}ms (${cmd.type})`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write(withId)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /** Idempotent: stdin close, wait up to 10s, then force-kill via taskkill. */
  async stop(): Promise<void> {
    this.requested = true
    if (!this.stopPromise) {
      this.stopPromise = this.doStop()
    }
    return this.stopPromise
  }

  private async doStop(): Promise<void> {
    if (!this.child || this.exited) return
    try {
      this.child.stdin.end()
    } catch (err) {
      console.error('OmpProcess: stdin.end() failed', err)
    }
    const exited = await this.waitForExit(STOP_GRACE_MS)
    if (!exited) {
      await this.hardKill()
    }
  }

  private async hardKill(): Promise<void> {
    const pid = this.child?.pid
    if (pid === undefined || this.exited) return
    // Executor form: see start() for why Promise.withResolvers() isn't available here.
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve())
    })
    // taskkill /F should be reliable; wait for the 'exit' event it triggers rather than a
    // second timeout, per contract ("resolve after exit").
    // Executor form: see start() for why Promise.withResolvers() isn't available here.
    await new Promise<void>((resolve) => {
      if (this.exited) {
        resolve()
        return
      }
      this.exitWaiters.push(resolve)
    })
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true)
    // Executor form: see start() for why Promise.withResolvers() isn't available here.
    return new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        resolve(false)
      }, timeoutMs)
      this.exitWaiters.push(() => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private onExit(code: number | null): void {
    try {
      this.exited = true
      this.chunks.clear()
      const pid = this.child?.pid
      if (typeof pid === 'number') {
        removeProcessRecord(pid).catch((err: unknown) => {
          console.error('OmpProcess: removeProcessRecord failed', err)
        })
      }
      const error = new Error('OmpProcess: omp process exited')
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      this.pending.clear()

      const waiters = this.exitWaiters
      this.exitWaiters = []
      for (const waiter of waiters) waiter()

      if (!this.exitEmitted) {
        this.exitEmitted = true
        this.emit('exit', { code, requested: this.requested })
      }
    } catch (err) {
      console.error('OmpProcess: error in exit handler', err)
    }
  }

  private buildStartFailure(reason: string): Error {
    const tail = this.stderrTail.slice(-STDERR_FAILURE_TAIL_BYTES)
    const hint = this.lastSpawnError?.code === 'ENOENT' ? ' (omp not found on PATH; set ompPath)' : ''
    const stderrPart = tail ? `\n--- stderr tail ---\n${tail}` : ''
    return new Error(`OmpProcess: ${reason}${hint}${stderrPart}`)
  }

  private onStdoutData(chunk: Buffer): void {
    try {
      this.stdoutBuf = Buffer.concat([this.stdoutBuf, chunk])
      let newlineIndex: number
      while ((newlineIndex = this.stdoutBuf.indexOf(0x0a)) >= 0) {
        const lineBuf = this.stdoutBuf.subarray(0, newlineIndex)
        this.stdoutBuf = this.stdoutBuf.subarray(newlineIndex + 1)
        const line = lineBuf.toString('utf8').trim()
        if (!line) continue
        this.handleLine(line)
      }
    } catch (err) {
      console.error('OmpProcess: error processing stdout', err)
    }
  }

  private onStderrData(chunk: Buffer): void {
    this.stderrBuf = Buffer.concat([this.stderrBuf, chunk])
    if (this.stderrBuf.length > STDERR_TAIL_BYTES) {
      this.stderrBuf = this.stderrBuf.subarray(this.stderrBuf.length - STDERR_TAIL_BYTES)
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      console.error('OmpProcess: skipping unparseable stdout line', err, line.slice(0, 200))
      return
    }
    this.handleParsed(parsed)
  }

  private handleParsed(parsed: unknown): void {
    if (typeof parsed !== 'object' || parsed === null || !('type' in parsed) || typeof parsed.type !== 'string') {
      console.error('OmpProcess: skipping malformed frame (no string type)', parsed)
      return
    }
    // `parsed` is now known to have a string `type` field, but TS can't connect that
    // shape to the Frame union (UnknownFrame's index signature would otherwise swallow
    // every property access below).
    const frame = parsed as Frame
    if (frame.type === 'rpc_chunk') {
      // Same reason as above: `type` narrowing alone can't isolate RpcChunkFrame here.
      const chunkFrame = frame as RpcChunkFrame
      this.handleChunk(chunkFrame)
      return
    }
    this.dispatchFrame(frame)
  }

  private dispatchFrame(frame: Frame): void {
    if (frame.type === 'response') {
      // Same reason as handleParsed: `type` narrowing alone can't isolate ResponseFrame.
      const responseFrame = frame as ResponseFrame
      const entry = this.pending.get(responseFrame.id)
      if (entry) {
        this.pending.delete(responseFrame.id)
        clearTimeout(entry.timer)
        entry.resolve(responseFrame)
      }
      // Responses are consumed by request() only; they are never emitted as 'frame'.
      return
    }
    this.emit('frame', frame)
  }

  // rpc_chunk reassembly (FINDINGS C22b / contracts/omp-usage.md "Failure handling"):
  // validates chunkId/index/count/byteLength, rejects interleaved or duplicate
  // sequences, enforces the 64 MiB reassembled ceiling, and decodes strictly as UTF-8.
  // Any failure drops the whole in-flight assembly and logs, same as an unparseable line.
  private handleChunk(frame: RpcChunkFrame): void {
    try {
      const { chunkId, index, count, byteLength, data } = frame
      if (typeof chunkId !== 'string' || chunkId.length === 0) {
        throw new Error('rpc_chunk missing chunkId')
      }
      if (!Number.isInteger(count) || count <= 0) {
        throw new Error(`rpc_chunk ${chunkId}: invalid count ${count}`)
      }
      if (!Number.isInteger(index) || index < 0 || index >= count) {
        throw new Error(`rpc_chunk ${chunkId}: invalid index ${index} for count ${count}`)
      }
      if (!Number.isInteger(byteLength) || byteLength < 0) {
        throw new Error(`rpc_chunk ${chunkId}: invalid byteLength ${byteLength}`)
      }
      if (byteLength > MAX_REASSEMBLED_BYTES) {
        throw new Error(`rpc_chunk ${chunkId}: byteLength ${byteLength} exceeds ${MAX_REASSEMBLED_BYTES} byte ceiling`)
      }
      if (typeof data !== 'string') {
        throw new Error(`rpc_chunk ${chunkId}: missing data`)
      }

      let assembly = this.chunks.get(chunkId)
      if (!assembly) {
        assembly = { parts: new Array<Buffer | undefined>(count), got: 0, byteLength }
        this.chunks.set(chunkId, assembly)
      } else if (assembly.parts.length !== count || assembly.byteLength !== byteLength) {
        this.chunks.delete(chunkId)
        throw new Error(`rpc_chunk ${chunkId}: interleaved sequence (count/byteLength changed mid-assembly)`)
      }
      if (assembly.parts[index] !== undefined) {
        this.chunks.delete(chunkId)
        throw new Error(`rpc_chunk ${chunkId}: duplicate index ${index} (interleaved sequence)`)
      }

      assembly.parts[index] = Buffer.from(data, 'base64')
      assembly.got += 1
      if (assembly.got < assembly.parts.length) return

      this.chunks.delete(chunkId)
      const parts: Buffer[] = assembly.parts.map((part, i) => {
        if (!part) throw new Error(`rpc_chunk ${chunkId}: missing part ${i} after completion`)
        return part
      })
      const whole = Buffer.concat(parts)
      if (whole.length !== assembly.byteLength) {
        throw new Error(`rpc_chunk ${chunkId}: got ${whole.length} bytes, expected ${assembly.byteLength}`)
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(whole)
      this.handleParsed(JSON.parse(text) as unknown)
    } catch (err) {
      console.error('OmpProcess: dropping malformed rpc_chunk', err)
    }
  }
}
