# Pinion

A desktop harness for [OMP (oh-my-pi)](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent). Pinion hosts OMP sessions in a three-pane app: a session list with one session per git worktree, an agent chat pane, and a pane for git changes, files, and a side chat.

Pinion drives OMP through `omp --mode rpc-ui`, one OMP process per session, so skills, extensions, MCP servers, and slash commands keep working.

## Status

Pre-implementation. The transport spike is recorded in [`docs/spike/`](docs/spike/FINDINGS.md). Specs are managed with [Spec Kit](https://github.com/github/spec-kit); start with the constitution in `.specify/memory/constitution.md`.

## Prerequisites

- Windows 11.
- Node 24 or newer, with `pnpm`.
- Git for Windows.
- `omp` 18.4.x on `PATH`, signed in (`omp --version` prints `omp/18.4.x`).

## Running

```
pnpm install
pnpm dev          # Electron with hot reload (electron-vite dev)
pnpm build        # production build (electron-vite build), output in out/
pnpm typecheck    # tsc --noEmit over the main and web projects
```

There is no packaged installer yet. After `pnpm build`, launch the built app directly:

```
node_modules/electron/dist/electron.exe .
```

## Where state lives

Pinion keeps no state in the repo. Everything is under Electron's `userData` directory (`app.getPath('userData')`; on Windows, `%APPDATA%/pinion` in a packaged build, a dev-specific path under `electron-vite`/Electron's default in `pnpm dev`):

| File | Holds |
|---|---|
| `registry.json` | Every Repository and Session Pinion knows about (`src/main/store/registry.ts`). |
| `settings.json` | The single app-wide Settings row, currently just Approval mode (`src/main/store/settings.ts`). |
| `processes.json` | pids of live `omp` root processes, used to detect and reap orphans left by a crash (`src/main/process/pidRecords.ts`). |

A Session's worktree lives next to the Repository it belongs to, not under `userData`: `<repo>/../pinion-worktrees/<repoName>/<name>` (`src/main/git/worktrees.ts`).

## Where things live

| What | Where |
|---|---|
| Vocabulary | [`CONTEXT.md`](CONTEXT.md) |
| Look, feel, and interaction rules | [`docs/DESIGN.md`](docs/DESIGN.md) |
| Rules for building Pinion | [`.specify/memory/constitution.md`](.specify/memory/constitution.md) |
| What OMP does over RPC | [`docs/spike/FINDINGS.md`](docs/spike/FINDINGS.md) |
| Feature behaviour | [`specs/`](specs/) |
| Ideas, features, and bugs | [GitHub issues](https://github.com/stuarthopwood/pinion/issues) |

## Spec workflow

Run these slash commands inside OMP, in this directory:

1. `/speckit.constitution`
2. `/speckit.specify`
3. `/speckit.plan`
4. `/speckit.tasks`
5. `/speckit.implement`
6. `/speckit.converge`
