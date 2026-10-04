// Fork-safe pull-request checkout probe (research.md decision 6; tasks.md T005, issue #189).
//
// Question: does `git fetch origin pull/<number>/head:<local-branch>` then `git worktree add
// <path> <local-branch>` (no `-b`) succeed against a real GitHub remote, and what is the exact
// error text/exit code when a pull request's source ref is gone?
//
// Isolation: this script creates its OWN throwaway clone under the OS temp dir (never inside this
// repo or any of its worktrees, which all share one .git object/ref/worktree-list store -- running
// the fetch/worktree-add sequence from inside a real worktree of this repo would leave a stray
// branch ref and worktree entry visible from the primary checkout and every sibling worktree, not
// isolated to this probe).
//
// Like every other probe in this directory, this script never deletes anything: the clone and its
// worktrees are left under the OS temp dir (printed at the end) for manual cleanup, matching
// open-external-probe.mjs's own "never deletes anything" invariant -- a recursive delete of a
// directory containing a real `.git` is exactly the kind of command this workstation's own
// destructive-command guard (see skill safe-destructive-commands) is built to stop, so the safe
// choice is to not attempt it from inside an automated script at all.
//
// FORBIDDEN, no exceptions: this script never deletes a real remote branch to manufacture the
// "pull request whose source branch has since been deleted" case. Instead it looks for a real,
// already-closed pull request on the probed repo whose head branch ref is independently confirmed
// gone from `git ls-remote --heads`, and probes against that. If `gh pr list --state closed`
// finds none, the deleted-branch sub-case is recorded in FINDINGS.md as "not independently
// reproduced this round", not faked.
//
// READ-ONLY against the real repo: only `git clone`/`git ls-remote`/`git fetch`/`git worktree add`
// (plus `gh pr list` to find a closed PR). Nothing is pushed, deleted, or mutated on the remote.
//
// Run:  node docs/spike/gh-pr-checkout-probe.mjs
// Env:  REFRACT_PROBE_REPO  owner/repo to clone (default stuarthopwood/refract)
//       REFRACT_PROBE_PR    an open PR number to fetch/worktree-add (default 96)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const REPO = process.env.REFRACT_PROBE_REPO || "stuarthopwood/refract";
const OPEN_PR = process.env.REFRACT_PROBE_PR || "96";
const REMOTE_URL = `https://github.com/${REPO}.git`;

const ROOT = path.join(os.tmpdir(), "pinion-gh-pr-checkout-probe", new Date().toISOString().replace(/[:.]/g, "-"));
const CLONE_DIR = path.join(ROOT, "clone");
const WT_OPEN = path.join(ROOT, "wt-open");
const WT_CLOSED = path.join(ROOT, "wt-closed");
fs.mkdirSync(ROOT, { recursive: true });

function run(args, opts = {}) {
  try {
    const out = execFileSync(args[0], args.slice(1), { encoding: "utf8", timeout: 60_000, ...opts });
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, code: e.status ?? null, out: `${e.stdout || ""}${e.stderr || ""}`.trim() };
  }
}

const results = { repo: REPO, scratch: ROOT };

// 1. Clone fresh (own .git, isolated from this repo's shared object/ref store).
results.clone = run(["git", "clone", REMOTE_URL, CLONE_DIR]);

// 2. Find a real closed PR whose head ref is independently confirmed gone (never delete one to
// force this; only use one already gone).
const closedPrsRaw = run(["gh", "pr", "list", "--repo", REPO, "--state", "closed", "--limit", "50",
  "--json", "number,headRefName"]);
const refsRaw = run(["git", "ls-remote", "--heads", REMOTE_URL]);
let deletedBranchPr = null;
if (closedPrsRaw.ok && refsRaw.ok) {
  const closedPrs = JSON.parse(closedPrsRaw.out);
  const liveRefs = new Set(
    [...refsRaw.out.matchAll(/refs\/heads\/(.+)/g)].map((m) => m[1]),
  );
  deletedBranchPr = closedPrs.find((pr) => !liveRefs.has(pr.headRefName)) || null;
}
results.deletedBranchPrFound = deletedBranchPr;

if (results.clone.ok) {
  // 3. Open PR: fetch pull/<n>/head, then worktree add (the real decision-6 sequence).
  results.fetchOpen = run(["git", "fetch", "origin", `pull/${OPEN_PR}/head:pr-${OPEN_PR}-local`], { cwd: CLONE_DIR });
  results.worktreeAddOpen = run(["git", "worktree", "add", WT_OPEN, `pr-${OPEN_PR}-local`], { cwd: CLONE_DIR });

  if (deletedBranchPr) {
    const n = deletedBranchPr.number;
    // 4. Closed PR with a since-deleted branch: pull/<n>/head still fetches (GitHub keeps this
    // ref even after the source branch and the PR itself are closed), confirming decision 6's
    // rationale for using this ref form over the bare branch name.
    results.fetchClosedViaPullHead = run(["git", "fetch", "origin", `pull/${n}/head:pr-${n}-local`], { cwd: CLONE_DIR });
    results.worktreeAddClosed = results.fetchClosedViaPullHead.ok
      ? run(["git", "worktree", "add", WT_CLOSED, `pr-${n}-local`], { cwd: CLONE_DIR })
      : null;

    // 5. The actual "branch gone" error: fetching the bare (deleted) branch name directly, not
    // via pull/<n>/head, is what produces it -- this is the exact error text/exit code the
    // checkout-failed error code should surface if a caller ever does hit this path.
    results.fetchDeletedBranchDirectly = run(["git", "fetch", "origin", deletedBranchPr.headRefName], { cwd: CLONE_DIR });
  } else {
    // No naturally-deleted-branch PR was available on this repo this round. Record the same
    // error shape via a PR number confirmed not to exist at all, which exercises the identical
    // "couldn't find remote ref" git error class without deleting anything real.
    results.fetchNonexistentPrHead = run(["git", "fetch", "origin", "pull/999999/head:pr-999999-local"], { cwd: CLONE_DIR });
  }
}

console.log(JSON.stringify(results, null, 2));
console.log(`\nscratch clone left on disk for manual cleanup (this script never deletes anything): ${ROOT}`);
