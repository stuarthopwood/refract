# IPC contract: Token guard

All channels go through the single `refract_request(channel, args)` command (constitution V). Payloads are plain JSON; no path, command line or file content comes from the renderer.

## Requests (Lane A)
| Channel | Args | Result |
|---|---|---|
| `tokenGuard.get` | none | `{ values: TokenGuardValues, defaults: TokenGuardValues }` |
| `tokenGuard.set` | `{ key: string, value: unknown }` (key must be a known overlay key; value validated per type) | `{ values }` or error text |
| `tokenGuard.reset` | `{ key: string }` | `{ values }` |

## Requests (Lane B)
| Channel | Args | Result |
|---|---|---|
| `tokenGuard.handoff` | `{ sessionId: string }` | `{ ok: true }` or `{ ok: false, reason: string }`; refuses unless the Session is Idle |

## Events (backend to renderer)
| Event | Payload | Lane |
|---|---|---|
| `token-guard:launch-warning` | `{ sessionId?: string, reason: string }` (overlay or rules write failed, guard off for that launch) | A |
| `token-guard:calls` | `{ sessionId: string, conversationId: string, calls: number }` emitted on each count change (batched per frame burst) | B |

`pnpm check:parity` entries are added in the same change as each channel; the removed `omp-guard:reset` entry goes with Lane A.

## Internal (not IPC)
`/shake` is sent as `{"type":"prompt","message":"/shake"}` on the Session's process after `session_settled`; its `command_output` frame is not appended to the transcript.
