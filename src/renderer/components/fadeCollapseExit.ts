const EXIT_MS = 200

/** How long a leaving `FadeCollapse` stays mounted: 0 (unmount at once) when motion is reduced, whether by the OS or the Reduce motion switch (#566). */
export function exitDelayMs(motionReduced: boolean): number {
  return motionReduced ? 0 : EXIT_MS
}
