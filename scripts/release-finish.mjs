// `pnpm release --finish vX.Y.Z`: after the release PR is squash-merged, prove that commit is this release, then
// tag it and print the publish commands. Commands go through an injectable runner (`run`) so tests need no git.

import {
  assertCommitVersions,
  decideTag,
  finishFailureMessage,
  finishStepCommands,
  parseRemoteTagSha,
  phaseTwoPlan,
  pickMergedReleasePr,
  publishCommands,
  releaseBranchName,
} from './release-pr.mjs';
import { REPO_SLUG, exec, fail, installInterruptHandlers, printPlan, runStep, worktreeDirFor } from './release-run.mjs';
import { extractCargoTomlVersion } from './release-versions.mjs';

// Stdout of a command that must succeed, through the injected runner.
function output(run, argv) {
  const { status, stdout } = run(argv);
  if (status !== 0) fail(`${argv.join(' ')} failed`);
  return stdout.trim();
}

function versionAt(run, sha, file) {
  return JSON.parse(output(run, ['git', 'show', `${sha}:${file}`])).version;
}

// Finds the squash commit of the merged release PR on origin/main and proves it is this release.
function verifyMergedRelease(version, run = exec) {
  if (run(['git', 'fetch', 'origin'], { inherit: true }).status !== 0) fail('git fetch origin failed');

  const listed = output(run, [
    'gh', 'pr', 'list', '--repo', REPO_SLUG, '--head', releaseBranchName(version), '--state', 'all', '--limit', '20',
    '--json', 'number,state,url,baseRefName,headRepositoryOwner,mergeCommit',
  ]);
  const pr = pickMergedReleasePr(JSON.parse(listed), version);

  if (run(['git', 'merge-base', '--is-ancestor', pr.sha, 'origin/main']).status !== 0) {
    fail(`merge commit ${pr.sha} of ${pr.url} is not on origin/main`);
  }

  assertCommitVersions(version, {
    'package.json': versionAt(run, pr.sha, 'package.json'),
    'src-tauri/tauri.conf.json': versionAt(run, pr.sha, 'src-tauri/tauri.conf.json'),
    'src-tauri/Cargo.toml': extractCargoTomlVersion(
      output(run, ['git', 'show', `${pr.sha}:src-tauri/Cargo.toml`]),
      'src-tauri/Cargo.toml',
    ),
  });
  return pr;
}

function localTagSha(run, tagName) {
  const { status, stdout } = run(['git', 'rev-parse', '--verify', '--quiet', `refs/tags/${tagName}^{commit}`]);
  return status === 0 ? stdout.trim() : null;
}

export async function finishRelease({ dryRun, finishVersion: version }, run = exec) {
  const tagName = `v${version}`;
  const dir = worktreeDirFor(version);
  const step = (stepId, action) => runStep(stepId, (id, opts) => finishFailureMessage(id, version, opts), action);
  installInterruptHandlers();

  const pr = await step('verify-pr', () => verifyMergedRelease(version, run));
  const decision = await step('verify-pr', () =>
    decideTag({
      tagName,
      sha: pr.sha,
      localSha: localTagSha(run, tagName),
      remoteSha: parseRemoteTagSha(
        output(run, ['git', 'ls-remote', 'origin', `refs/tags/${tagName}`, `refs/tags/${tagName}^{}`]),
        tagName,
      ),
    }),
  );
  console.log(`release: ${pr.url} is merged as ${pr.sha}, and that commit carries v${version}.`);

  if (dryRun) {
    printPlan(`release --finish --dry-run: ${tagName} would:`, phaseTwoPlan(version, pr.sha, dir));
    console.log(
      `\nrelease --finish --dry-run: nothing was tagged or pushed (local tag ${decision.createLocal ? 'absent' : 'already present'}, ` +
        `origin tag ${decision.push ? 'absent' : 'already present'}). Only "git fetch origin" touched anything.`,
    );
    return;
  }

  const commands = finishStepCommands(version, pr.sha);
  const runInherit = (argv) => {
    if (run(argv, { inherit: true }).status !== 0) fail(`${argv.join(' ')} failed`);
  };
  if (decision.createLocal) await step('tag', () => runInherit(commands.tag));
  if (decision.push) await step('push-tag', () => runInherit(commands['push-tag']));

  console.log(`release: ${tagName} is tagged on ${pr.sha} and pushed. The publish stays a separate step; run it from a detached worktree at the tag:`);
  for (const line of publishCommands(version, dir)) console.log(`  ${line}`);
  console.log(`  (afterwards: cd back, then git worktree remove ${dir.replace(/\\/g, '/')})`);
}
