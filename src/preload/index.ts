import { contextBridge } from 'electron'
import type { PinionScaffoldCheckApi } from './api'

// Scaffold-verification API for the T003 sandbox gate: proves the preload script actually runs
// sandboxed and that contextBridge crosses the isolated world into the renderer. T018 replaces
// this wholesale with the window.pinion contract from contracts/ipc.md.

const pinionScaffoldCheck: PinionScaffoldCheckApi = {
  ping: () => ({
    message: 'pong',
    sandboxed: process.sandboxed,
    contextIsolated: process.contextIsolated
  })
}

contextBridge.exposeInMainWorld('pinionScaffoldCheck', pinionScaffoldCheck)
