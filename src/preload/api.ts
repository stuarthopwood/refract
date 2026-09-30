// Pure type contract for the preload bridge, with no electron import, so both
// tsconfig.node.json (preload/main) and tsconfig.web.json (renderer) programs can include it.
export interface ScaffoldCheckResult {
  message: string
  sandboxed: boolean
  contextIsolated: boolean
}

export interface PinionScaffoldCheckApi {
  ping: () => ScaffoldCheckResult
}
