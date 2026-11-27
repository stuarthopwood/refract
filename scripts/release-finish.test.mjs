import { afterEach, describe, expect, it, vi } from 'vitest';
import { finishRelease } from './release-finish.mjs';

const SHA = 'abc123';
const merged = [
  {
    number: 9,
    url: 'https://x/pull/9',
    state: 'MERGED',
    baseRefName: 'main',
    headRepositoryOwner: { login: 'stuarthopwood' },
    mergeCommit: { oid: SHA },
  },
];
const cargoToml = '[package]\nname = "refract-tauri"\nversion = "1.2.3"\n';

// A fake `run` that answers each git/gh command the finish step issues and records every argv.
// `prs` overrides the `gh pr list` answer; `ancestor` is the `merge-base --is-ancestor` exit status.
function fakeRunner({ localTag = false, prs = merged, ancestor = 0 } = {}) {
  const calls = [];
  const run = (argv) => {
    calls.push(argv);
    const text = argv.join(' ');
    if (text.startsWith('gh pr list')) return { status: 0, stdout: JSON.stringify(prs) };
    if (text.startsWith('git merge-base --is-ancestor')) return { status: ancestor, stdout: '' };
    if (text === `git show ${SHA}:package.json` || text === `git show ${SHA}:src-tauri/tauri.conf.json`) {
      return { status: 0, stdout: JSON.stringify({ version: '1.2.3' }) };
    }
    if (text === `git show ${SHA}:src-tauri/Cargo.toml`) return { status: 0, stdout: cargoToml };
    if (text.startsWith('git rev-parse')) return localTag ? { status: 0, stdout: `${SHA}\n` } : { status: 1, stdout: '' };
    return { status: 0, stdout: '' };
  };
  return { run, calls };
}

describe('finishRelease', () => {
  afterEach(() => vi.restoreAllMocks());

  it('picks the merged PR, checks it is on origin/main, then tags and pushes only the tag', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { run, calls } = fakeRunner();

    await finishRelease({ dryRun: false, finishVersion: '1.2.3' }, run);

    const lines = calls.map((argv) => argv.join(' '));
    const at = (prefix) => lines.findIndex((l) => l.startsWith(prefix));
    expect(at('gh pr list')).toBeGreaterThan(-1);
    expect(at('gh pr list')).toBeLessThan(at('git merge-base --is-ancestor'));
    expect(at('git merge-base --is-ancestor')).toBeLessThan(at('git tag -a'));
    expect(lines).toContain(`git tag -a v1.2.3 -m v1.2.3 ${SHA}`);
    expect(lines.at(-1)).toBe('git push origin refs/tags/v1.2.3');
    expect(lines.filter((l) => l.startsWith('git push'))).toEqual(['git push origin refs/tags/v1.2.3']);
  });

  it('writes nothing under --dry-run', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { run, calls } = fakeRunner();

    await finishRelease({ dryRun: true, finishVersion: '1.2.3' }, run);

    const lines = calls.map((argv) => argv.join(' '));
    expect(lines.some((l) => l.startsWith('git tag') || l.startsWith('git push'))).toBe(false);
  });

  it('reuses an existing local tag on the merged commit and only pushes it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { run, calls } = fakeRunner({ localTag: true });

    await finishRelease({ dryRun: false, finishVersion: '1.2.3' }, run);

    const lines = calls.map((argv) => argv.join(' '));
    expect(lines.some((l) => l.startsWith('git tag -a'))).toBe(false);
    expect(lines.at(-1)).toBe('git push origin refs/tags/v1.2.3');
  });

  // `runStep` reports a failure and calls process.exit; turn that into a throw so the refusal is observable.
  async function expectRefusal(runner) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    await expect(finishRelease({ dryRun: false, finishVersion: '1.2.3' }, runner.run)).rejects.toThrow('exit 1');
    const lines = runner.calls.map((argv) => argv.join(' '));
    expect(lines.some((l) => l.startsWith('git tag') || l.startsWith('git push'))).toBe(false);
  }

  it('refuses when the release PR is only open', async () => {
    await expectRefusal(fakeRunner({ prs: [{ ...merged[0], state: 'OPEN', mergeCommit: null }] }));
  });

  it('refuses a merged PR from a fork', async () => {
    await expectRefusal(fakeRunner({ prs: [{ ...merged[0], headRepositoryOwner: { login: 'someone-else' } }] }));
  });

  it('refuses when the merge commit is not on origin/main', async () => {
    await expectRefusal(fakeRunner({ ancestor: 1 }));
  });
});
