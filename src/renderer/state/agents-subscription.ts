import { useAgentsStore } from './agents-store'

/** Feeds `agents:update` into the Agents store, then pulls the aggregate once for the push this renderer missed. Returns the disposer. */
export function initAgentsSubscription(): () => void {
  let pushed = false
  const stop = window.refract.onAgentsUpdate(({ groups }) => {
    pushed = true
    useAgentsStore.getState().apply(groups)
  })
  // Rust dedupes unchanged pushes, so a renderer that subscribes late (start, webview reload) would otherwise wait for a change.
  // Pulled after subscribing so nothing lands in the gap; a push that beat the reply is newer, so it is kept.
  void window.refract.agents
    .snapshot()
    .then((result) => {
      if (result.ok && !pushed) useAgentsStore.getState().apply(result.value.groups)
    })
    // A rejected invoke leaves the store empty until the first push, which is the pre-pull behaviour.
    .catch(() => {})
  return stop
}
