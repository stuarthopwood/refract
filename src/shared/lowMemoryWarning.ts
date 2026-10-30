/** `memory:warning` payload. */
export interface LowMemoryWarning {
  low: boolean;
  freeBytes: number;
  liveAgents: number;
}
