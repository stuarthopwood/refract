# Quickstart: verifying the installer and updates

Refract is a prototype with no automated tests. Each check below is a manual run of the built
app. Requirement and story numbers refer to [spec.md](spec.md); data and protocol details are in
[data-model.md](data-model.md) and [contracts/](contracts/).

## Prerequisites

- Windows 11, a clean (or disposable VM) profile with no Refract, Git, or OMP installed, for
  Stories 1, 2, and 4.
- A second, ordinary developer profile with Git, OMP 18.4.x or 18.5.x, and the signed-in GitHub CLI already
  present, for Story 3 (updates) and the readiness checklist's happy path.
- A private GitHub Release, published by Story 5's own workflow against a scratch tag, carrying an
  installer and checksum asset newer than the currently installed build, for Story 3.
- `pnpm install`, `pnpm build`, then `pnpm package` (new script, `research.md` decision 1) to
  produce the installer under `release/`.

## Checks per story

**Story 1: install Refract (FR-001 to FR-004, SC-001, SC-002)**

1. On the clean profile, run the built installer file. Expect: no administrator prompt, and it
   completes in a few seconds.
2. Check the Desktop and the Start menu: both show a Refract shortcut with the Refract icon, and
   both open Refract.
3. Open Windows Settings > Apps: Refract is listed with its installed version.
4. First launch shows the first-run readiness screen (Story 2).
5. Add a repository, create a Session, change the Approval mode. Quit, then run the same installer
   file again. Expect: it completes the same way, and reopening Refract shows the same repository,
   Session, and Approval mode unchanged.

**Story 2: get missing dependencies from the first-run screen (FR-005 to FR-011)**

1. On the clean profile (Git and OMP both absent), open Refract. Expect: the checklist shows Git
   and OMP missing, each with an Install action, and a GitHub CLI row marked optional.
2. Select Install next to Git. Expect: progress shows, then an outcome; the checklist re-checks
   itself and Git shows found, with no administrator prompt from Refract itself (Git's own
   installer may still show one; `research.md` decision 6 names which this build uses).
3. Select Install next to OMP. Expect: progress, then found on a supported `18.4.x`/`18.5.x` version; the
   OMP sign-in step still shows its existing manual hint, never completed automatically.
4. Leave the GitHub CLI missing. Expect: **Add repository** is still enabled once Git, OMP, and
   sign-in all pass.
5. Disconnect the network, then select Install next to any dependency. Expect: an actionable
   failure (not a success), and the item still offers Install afterwards.

**Story 3: learn about and install updates (FR-012 to FR-019, SC-004 to SC-008)**

1. On the ordinary profile, with a newer private Release already published (Story 5), start
   Refract. Expect: within 5 seconds, a badge near the (today's) status bar shows the new version
   and a release-notes link that opens in the system browser.
2. Select the badge's Check for updates action. Expect: it checks again immediately.
3. Select Update. Expect: it downloads, verifies the checksum, and the badge now offers "quit to
   install" rather than "Update" again.
4. Start a Session turn, then quit Refract normally once it finishes. Expect: the quit installs the
   update (observe the install happen, for example a brief extra process), and the next launch
   reports the new version everywhere a version shows.
5. Start a long-running turn, then try to quit. Expect: Refract's existing stop-all-agents-on-quit
   behaviour (spec 001 FR-031) runs as before; the update never forces or skips that.
6. Sign the GitHub CLI out (`gh auth logout`), then select Check for updates. Expect: a plain-words
   message, no error toast, and the rest of the app keeps working.
7. Leave Refract open while a newer Release is published (FR-032 to FR-035). Expect: with no
   clicks, within 4 hours the update downloads in the background, a "Refract <version> is ready"
   row with Update now appears in the sidebar, and the footer badge reads "Update ready".
8. Start an agent turn, then select Update now. Expect: a confirmation names the running-agent
   count; Cancel keeps everything running; Restart and update stops the agents, installs, and
   relaunches Refract. With no agent running, Update now proceeds directly.

**Story 4: uninstall (FR-021 to FR-024, SC-009)**

1. With Refract installed (Story 1) and a repository/Session recorded, open Windows Settings >
   Apps and start uninstalling. Expect: a keep-or-delete-data prompt, default **keep**.
2. Leave the default (keep) and finish. Expect: the Desktop shortcut, Start menu entries, and
   program files are gone; `%APPDATA%/pinion` (registry.json, settings.json) still exists; Git,
   OMP, the GitHub CLI, the repository, its worktree, and its OMP conversations are untouched.
3. Reinstall, then uninstall again choosing **delete**. Expect: `%APPDATA%/pinion` is removed this
   time; everything else in step 2's untouched list is still untouched.
4. With Refract running, start an uninstall from its Start Menu folder's uninstall entry. Expect:
   it asks to close Refract first rather than removing files out from under it.

**Story 5: publish a release (maintainer) (FR-025, FR-026)**

1. Bump `package.json`'s version, commit, and push a matching `vX.Y.Z` tag. Expect: the
   `release.yml` workflow runs, builds, and publishes a private GitHub Release carrying the
   installer and its checksum file.
2. Push a second tag whose `package.json` version was **not** bumped to match. Expect: the
   workflow's version guard fails the job rather than publishing a mismatched release.
3. Manually delete the checksum asset from a published (scratch) release, then run Story 3's
   update check against it. Expect: that release is never offered.
4. Mark a scratch release as a draft, and separately as a pre-release. Expect: neither is ever
   offered by the update check.

## First-task gates

These OMP, Electron, GitHub CLI, or Windows facts are unverified and are checked before the work
that depends on them, per constitution Principle IV:

- Whether OMP's install script (`omp.sh/install.ps1`) can pin a version and run unattended, and
  whether the pinned tag matches what `omp --version` later reports (`research.md` decision 6).
- Whether Git for Windows and the GitHub CLI can install silently without an administrator prompt
  (`research.md` decision 6).
- Whether the packaged NSIS installer truly needs no admin, registers in Apps & Features with its
  version, and upgrades in place (`research.md` decisions 1 to 2).
- Whether the custom uninstall keep/delete-data page and the running-instance guard work, both
  interactively and under the silent `/S` switch (`research.md` decision 2).
- Whether `gh release download`/`view` work against this private repository while signed in, and
  whether `gh auth status`/a failed call reliably distinguish not-installed, signed-out, and
  offline (`research.md` decision 3).
