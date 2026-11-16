
## Stacked pull requests

Open every pull request as a GitHub stacked pull request with the `gh stack` extension. Never use `gh pr create`.

- Dependent work goes in one stack, bottom to top: each layer builds on the one below it.
- Start a stack with `gh stack init <branch>`. Add a layer with `gh stack add <branch>` (a positional branch name).
- Publish the stack with `gh stack submit --auto`. Check it with `gh stack view --json`.
- Never run a command that prompts. Pass every choice as a flag.
- If a `gh stack` command exits with code 9, stacks are not enabled for this repository. Stop, report that, and do not retry.
