# Pinion

A desktop harness for [OMP (oh-my-pi)](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent). Pinion hosts OMP sessions in a three-pane app: a session list with one session per git worktree, an agent chat pane, and a pane for git changes, files, and a side chat.

Pinion drives OMP through `omp --mode rpc-ui`, one OMP process per session, so skills, extensions, MCP servers, and slash commands keep working.

## Status

Pre-implementation. The transport spike is recorded in [`docs/spike/`](docs/spike/FINDINGS.md). Specs are managed with [Spec Kit](https://github.com/github/spec-kit); start with the constitution in `.specify/memory/constitution.md`.

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
