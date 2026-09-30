import type { PinionScaffoldCheckApi } from './api'

declare global {
  interface Window {
    pinionScaffoldCheck: PinionScaffoldCheckApi
  }
}
