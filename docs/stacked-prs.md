# Stacked PRs

On 2026-11-10 the user decided that every Refract PR opens through GitHub stacked PRs, using the `gh stack` extension (v0.3.0 or later; v0.1.0 reports a false exit code 9). This applies to single-PR lanes and docs-only plan PRs too. GitHub treats only two or more linked PRs as a stack, so the merge command depends on the stack's size. AGENTS.md keeps the summary rule.

## Set up once

In the main checkout, run these commands so `gh stack` never prompts:

```bash
git config rerere.enabled true
git config remote.pushDefault origin
```

## Run every command non-interactively

Always pass branch names as positional arguments, use `submit --auto`, and use `view --json`. A bare `gh stack view`, `submit`, `init`, `add`, or `checkout` opens a prompt or a TUI and hangs.

## Open a PR

1. `gh stack init` branches from your local `main`, so first run `git fetch -q origin` and `git merge --ff-only origin/main` in the main checkout. Then create the stack with `gh stack init --base main <branch>`. This creates and checks out `<branch>`.
2. Commit with plain `git add` and `git commit`.
3. Run `gh stack submit --auto --open`. This pushes the branch, opens the PR as a draft, and links it into a stack on GitHub. Run `gh pr ready <pr>` before you merge.
4. Check the result with `gh stack view --json`.

Put dependent work in one stack, from the bottom layer to the top layer: run `gh stack add <branch>` for each next layer, and commit in it. Give independent work its own stack.

## Fix the PR title

`submit --auto` builds the title from the branch:

- One commit on the branch: the title is the commit subject. Make the subject a Conventional Commits title (see `docs/pr-titles.md`).
- More than one commit: the title is the humanized branch name. Fix it with `gh pr edit <pr> --title "type(scope): subject"`.

## Merge

- **Stack of two or more PRs:** run `gh stack merge <pr> --yes --squash`. The command merges every PR from the bottom of the stack up to and including `<pr>`, all or nothing. Never run `gh pr merge` on a stacked PR; it does not work.
- **Stack of one PR:** GitHub does not treat it as a stack, and `gh stack merge` refuses it. Run `gh pr merge <pr> --squash --delete-branch`.

The repository deletes the head branch on merge.

After the merge, the controller reaps the worktree (see `.omp/skills/worktree-reap/SKILL.md`).

## Change a lower layer

When review feedback or a bug needs a change in a lower layer:

1. Check out that layer: `gh stack down`, `gh stack bottom`, or `gh stack checkout <branch>`.
2. Commit the change there.
3. Run `gh stack rebase --upstack`, then `gh stack push`.

## Handle failures

- Exit code 9 says the repository has stacks disabled. On GitHub, stacks need no enablement, so first check that `gh extension list` shows `gh-stack` v0.3.0 or later and that the active `gh` account can read the repository. If both hold, stop and tell the user. Do not fall back to `gh pr create`.
- Exit code 3 means a rebase conflict. Resolve the files, run `git add`, then `gh stack rebase --continue`. To give up, run `gh stack rebase --abort`.
- Exit code 6 means a branch belongs to more than one stack. Check out a branch that is in only one stack.
