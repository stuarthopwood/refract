import { describe, expect, it } from 'vitest';
import {
  assertBranchMatchesVersion,
  assertCleanTree,
  assertCommitVersions,
  assertHeadAtOriginMain,
  classifyBranch,
  decideTag,
  finishFailureMessage,
  openedPrMessage,
  parseArgs,
  parseRemoteTagSha,
  phaseOnePlan,
  phaseTwoPlan,
  pickMergedReleasePr,
  prStepCommands,
  prStepFailureMessage,
  publishCommands,
  releaseCommitSubject,
  resumeFromStep,
} from './release-pr.mjs';

describe('parseArgs', () => {
  it('reads a bump level and --dry-run', () => {
    expect(parseArgs(['minor', '--dry-run'])).toEqual({ dryRun: true, level: 'minor', finishVersion: null });
  });

  it('accepts --finish with or without the v prefix', () => {
    expect(parseArgs(['--finish', 'v1.2.3']).finishVersion).toBe('1.2.3');
    expect(parseArgs(['--finish', '1.2.3', '--dry-run'])).toMatchObject({ finishVersion: '1.2.3', dryRun: true });
  });

  it('rejects --finish without a valid version', () => {
    expect(() => parseArgs(['--finish'])).toThrow(/--finish needs the release tag/);
    expect(() => parseArgs(['--finish', 'next'])).toThrow(/--finish needs the release tag/);
  });

  it('rejects --finish combined with a bump level', () => {
    expect(() => parseArgs(['--finish', 'v1.2.3', 'patch'])).toThrow(/takes no bump level/);
  });

  it('rejects unknown arguments', () => {
    expect(() => parseArgs(['--force'])).toThrow(/unknown argument\(s\): --force/);
  });
});

describe('release preconditions', () => {
  it('allows main and release/* and refuses any other branch', () => {
    expect(classifyBranch('main')).toEqual({ kind: 'main', version: null });
    expect(classifyBranch('release/v1.2.3')).toEqual({ kind: 'release', version: '1.2.3' });
    expect(classifyBranch('release/odd')).toEqual({ kind: 'release', version: null });
    expect(() => classifyBranch('feat/x')).toThrow(/main or a release\/\* branch \(current: feat\/x\)/);
  });

  it('refuses a dirty tree and a HEAD that is not origin/main', () => {
    expect(() => assertCleanTree(' M a.txt')).toThrow(/not clean/);
    expect(() => assertCleanTree('')).not.toThrow();
    expect(() => assertHeadAtOriginMain('a', 'b')).toThrow(/does not equal origin\/main/);
    expect(() => assertHeadAtOriginMain('a', 'a')).not.toThrow();
  });

  it('requires a release/* start branch to be the branch of the inferred version', () => {
    const info = classifyBranch('release/v1.2.3');
    expect(() => assertBranchMatchesVersion(info, 'release/v1.2.3', '1.2.3')).not.toThrow();
    expect(() => assertBranchMatchesVersion(info, 'release/v1.2.3', '1.3.0')).toThrow(/release\/v1\.3\.0/);
    expect(() => assertBranchMatchesVersion(classifyBranch('main'), 'main', '1.3.0')).not.toThrow();
  });
});

describe('phase 1 commands and recovery', () => {
  it('uses gh stack flags only and never gh pr create or a push of main', () => {
    const commands = Object.values(prStepCommands('1.2.3')).map((c) => c.join(' '));
    expect(commands).toEqual([
      'git push --set-upstream origin release/v1.2.3',
      'gh stack init --base main release/v1.2.3',
      'gh stack submit --auto --open --remote origin',
    ]);
    expect(commands.join('\n')).not.toMatch(/pr create|origin main/);
  });

  it('titles the commit, and so the PR, chore(release): vX.Y.Z', () => {
    expect(releaseCommitSubject('1.2.3')).toBe('chore(release): v1.2.3');
  });

  it('resumes from the failed step onward only', () => {
    expect(resumeFromStep('submit', '1.2.3')).toBe('gh stack submit --auto --open --remote origin');
    expect(resumeFromStep('push', '1.2.3').split(' && ')).toHaveLength(3);
  });

  it('names the failed step, the resume command and the abandon route', () => {
    const msg = prStepFailureMessage('stack-init', '1.2.3', { detail: 'boom' });
    expect(msg).toContain('gh stack init step failed: boom');
    expect(msg).toContain('Resume from that step: gh stack init --base main release/v1.2.3 && gh stack submit');
    expect(msg).toContain('pnpm release --finish v1.2.3');
    expect(msg).toContain('git branch -D release/v1.2.3');
    expect(prStepFailureMessage('push', '1.2.3', { interrupted: true })).toContain('stopped by SIGINT/SIGTERM');
  });

  it('prints the merge and resume commands when the PR opened', () => {
    const msg = openedPrMessage('1.2.3', { number: 7, url: 'https://x/pull/7' });
    expect(msg).toContain('gh pr merge 7 --squash --delete-branch');
    expect(msg).toContain('pnpm release --finish v1.2.3');
    expect(openedPrMessage('1.2.3', null)).toContain('gh pr merge <pr>');
  });

  it('plans the whole of phase 1 for a dry run', () => {
    const plan = phaseOnePlan('1.2.3', 'main');
    expect(plan[0]).toMatch(/git switch -c release\/v1\.2\.3/);
    expect(plan.at(-1)).toContain('never pushes main');
    expect(phaseOnePlan('1.2.3', 'release/v1.2.3')[0]).toBe('stay on release/v1.2.3');
  });
});

describe('phase 2 (--finish)', () => {
  const merged = { number: 9, url: 'https://x/pull/9', state: 'MERGED', baseRefName: 'main', mergeCommit: { oid: 'abc' } };

  it('picks the merged release PR and its squash commit', () => {
    expect(pickMergedReleasePr([merged], '1.2.3')).toEqual({ number: 9, url: 'https://x/pull/9', sha: 'abc' });
  });

  it('refuses an open, closed or missing PR with the next step named', () => {
    expect(() => pickMergedReleasePr([{ ...merged, state: 'OPEN', mergeCommit: null }], '1.2.3')).toThrow(
      /still open.*pnpm release --finish v1\.2\.3/s,
    );
    expect(() => pickMergedReleasePr([{ ...merged, state: 'CLOSED', mergeCommit: null }], '1.2.3')).toThrow(
      /closed without merging/,
    );
    expect(() => pickMergedReleasePr([], '1.2.3')).toThrow(/no pull request from release\/v1\.2\.3/);
    expect(() => pickMergedReleasePr([{ ...merged, baseRefName: 'dev' }], '1.2.3')).toThrow(/no pull request/);
  });

  it('refuses a squash commit whose manifests are not the release version', () => {
    expect(() => assertCommitVersions('1.2.3', { 'package.json': '1.2.3' })).not.toThrow();
    expect(() => assertCommitVersions('1.2.3', { 'package.json': '1.2.2' })).toThrow(/package\.json=1\.2\.2/);
  });

  it('reads the peeled commit of an annotated remote tag', () => {
    const out = 'tagobj\trefs/tags/v1.2.3\ncommit1\trefs/tags/v1.2.3^{}\n';
    expect(parseRemoteTagSha(out, 'v1.2.3')).toBe('commit1');
    expect(parseRemoteTagSha('lightweight\trefs/tags/v1.2.3\n', 'v1.2.3')).toBe('lightweight');
    expect(parseRemoteTagSha('', 'v1.2.3')).toBeNull();
  });

  it('tags and pushes on a first run, resumes a half-done run, and never moves a wrong tag', () => {
    const base = { tagName: 'v1.2.3', sha: 'abc' };
    expect(decideTag({ ...base, localSha: null, remoteSha: null })).toEqual({ createLocal: true, push: true });
    expect(decideTag({ ...base, localSha: 'abc', remoteSha: null })).toEqual({ createLocal: false, push: true });
    expect(decideTag({ ...base, localSha: 'abc', remoteSha: 'abc' })).toEqual({ createLocal: false, push: false });
    expect(() => decideTag({ ...base, localSha: 'old', remoteSha: null })).toThrow(/git tag -d v1\.2\.3/);
    expect(() => decideTag({ ...base, localSha: null, remoteSha: 'old' })).toThrow(/not moving it/);
  });

  it('names the failed step and the re-run command', () => {
    for (const step of ['verify-pr', 'tag', 'push-tag']) {
      expect(finishFailureMessage(step, '1.2.3', { detail: 'x' })).toContain('pnpm release --finish v1.2.3');
    }
    expect(finishFailureMessage('push-tag', '1.2.3', { interrupted: true })).toContain('SIGINT/SIGTERM');
  });

  it('prints the publish commands for a detached worktree at the tag', () => {
    expect(publishCommands('1.2.3', 'C:\\w\\refract-release-v1.2.3')).toEqual([
      'git worktree add --detach C:/w/refract-release-v1.2.3 v1.2.3',
      'cd C:/w/refract-release-v1.2.3',
      'pnpm install --frozen-lockfile',
      'pnpm release:local -- --notes-from-changelog',
    ]);
    expect(phaseTwoPlan('1.2.3', 'abc', '/w/r').join('\n')).toContain('git tag -a v1.2.3 -m v1.2.3 abc');
  });
});
