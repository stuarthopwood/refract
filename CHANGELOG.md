# Changelog

## v0.36.0 (2026-11-14)

### Features

- feat(issues): borderless accent-text label overflow chip (#1873) (https://github.com/stuarthopwood/refract/pull/1999)

### Fixes

- fix(settings): label the task model role Task, not Subagent (#1879) (https://github.com/stuarthopwood/refract/pull/1998)
- fix(chat): blur the history behind the Starting agent notice (#1892) (https://github.com/stuarthopwood/refract/pull/2000)
- fix(chat): Ask card recommended option is visible, preselected and one key from accepted (#1985) (https://github.com/stuarthopwood/refract/pull/1997)

## v0.35.0 (2026-11-13)

### Features

- feat(chat): ref links open the right pane (#1950) (https://github.com/stuarthopwood/refract/pull/1969)
- feat(pull-requests): stacked pull requests via gh stack (#1867) (https://github.com/stuarthopwood/refract/pull/1968)
- feat(#1859): agents create and nest Sessions (https://github.com/stuarthopwood/refract/pull/1967)

### Fixes

- fix(chat): name the live ask card and tighten its live check (#1941) (https://github.com/stuarthopwood/refract/pull/1970)
- fix(composer): chip shows the role from start and resume (#1878) (https://github.com/stuarthopwood/refract/pull/1996)

### Other

- docs(plan): queue #1980 flaky worktree delete-check test (https://github.com/stuarthopwood/refract/pull/1981)
- docs(plan): add #1982 chat/status-line preview and #1983 percent sliders (https://github.com/stuarthopwood/refract/pull/1984)
- docs(plan): add ask-card redesign epic #1990 and children #1985-#1989 (https://github.com/stuarthopwood/refract/pull/1991)
- docs(plan): add #1992 first-install ghost button row (https://github.com/stuarthopwood/refract/pull/1993)
- docs(plan): add #1994 app version in profile menu row (https://github.com/stuarthopwood/refract/pull/1995)

## v0.34.0 (2026-11-13)

### Features

- feat(sessions): agent Session read tools and messaging (#1858) (https://github.com/stuarthopwood/refract/pull/1953)

### Fixes

- fix(chat): advisory stripe beside body only and accent agent rows (#1876, #1877) (https://github.com/stuarthopwood/refract/pull/1960)
- fix(settings): state where compaction starts once (#1872) (https://github.com/stuarthopwood/refract/pull/1958)
- fix(session): resume starts a stopped paused Session (#1890) (https://github.com/stuarthopwood/refract/pull/1959)

### Other

- docs(plan): file #1946 plan-mode role and #1947 ref tooltip prefetch (https://github.com/stuarthopwood/refract/pull/1948)
- docs(plan): add Queue rows for filed issues and set Wave 2 (https://github.com/stuarthopwood/refract/pull/1949)
- docs(plan): add #1950 chat ref-link right-pane row (https://github.com/stuarthopwood/refract/pull/1952)
- docs(context): add Session message term and ADR 0008 (#1858) (https://github.com/stuarthopwood/refract/pull/1951)
- docs(plan): add #1954 low-memory triage-button row (https://github.com/stuarthopwood/refract/pull/1955)
- docs(plan): add #1961 tool-call view-full-call menu row (https://github.com/stuarthopwood/refract/pull/1962)
- chore(settings): live-verify token-guard keys (#1935) (https://github.com/stuarthopwood/refract/pull/1964)
- docs(plan): add #1972 central scratch-folder feature row (https://github.com/stuarthopwood/refract/pull/1973)
- docs(agents): put all scratch under C:/Scratch and always tidy it (https://github.com/stuarthopwood/refract/pull/1971)
- docs(plan): record OMP 18.20.0 review ledger row (#1976, #1977) (https://github.com/stuarthopwood/refract/pull/1978)
- docs(plan): queue #1974 dev scripts scratch under %TEMP%\scratch (https://github.com/stuarthopwood/refract/pull/1975)

## v0.33.0 (2026-11-12)

### Features

- feat(composer): slash commands before the agent starts (https://github.com/stuarthopwood/refract/pull/1837)
- feat(composer): # picker to search and insert issue and PR references (https://github.com/stuarthopwood/refract/pull/1844)
- feat(chat): combined card for HTML-form asks (https://github.com/stuarthopwood/refract/pull/1938)
- feat(session): pause cancels running subagents (https://github.com/stuarthopwood/refract/pull/1939)

### Fixes

- fix(chat): show the Skill invoked row for skill prompts with a summary tooltip (https://github.com/stuarthopwood/refract/pull/1838)
- fix(tool-channel): report unknown outcome and allow 30 s for agent panel mutations (https://github.com/stuarthopwood/refract/pull/1936)
- fix(profile): Keyboard shortcuts list scrolls inside its dialog (https://github.com/stuarthopwood/refract/pull/1934)
- fix(settings): token guard changes reach running Sessions (https://github.com/stuarthopwood/refract/pull/1937)
- fix(security): clear open CodeQL alerts (https://github.com/stuarthopwood/refract/pull/1943)
- fix(usage): tool Cost share shows a percentage (#1845) (https://github.com/stuarthopwood/refract/pull/1933)

### Other

- chore(composer): trim comments in the #1812 live check (https://github.com/stuarthopwood/refract/pull/1923)
- test(chat): prove the Skill invoked row after a relaunch (#1817) (https://github.com/stuarthopwood/refract/pull/1924)
- docs(plan): file #1931 subagents card redesign epic (https://github.com/stuarthopwood/refract/pull/1932)
- docs(plan): mark Wave 1 and the CodeQL cleanup done (https://github.com/stuarthopwood/refract/pull/1944)

## v0.32.0 (2026-11-11)

### Features

- feat(chat): link GitHub issue and PR references with a hover card (https://github.com/stuarthopwood/refract/pull/1826)
- feat(usage): scope and range toggles in the Session usage panel (https://github.com/stuarthopwood/refract/pull/1786)
- feat(agent-sessions): OMP host tool channel and panel tools (https://github.com/stuarthopwood/refract/pull/1871)

### Fixes

- fix(token-guard): guard maintenance pause against resets and collapse warnings in place (https://github.com/stuarthopwood/refract/pull/1787)
- fix(sessions): refuse agent start while its worktree is being deleted (https://github.com/stuarthopwood/refract/pull/1785)
- fix(deps): bump vulnerable dependencies for Dependabot alerts (https://github.com/stuarthopwood/refract/pull/1902)
- fix(worktree): harden the worktree delete flow (https://github.com/stuarthopwood/refract/pull/1788)
- fix(sessions): route persistent error toasts through one assertive helper (https://github.com/stuarthopwood/refract/pull/1773)

### Other

- docs(plan): add #1839 and #1840 git panel issues (https://github.com/stuarthopwood/refract/pull/1841)
- docs(plan): add #1842 file explorer git actions (https://github.com/stuarthopwood/refract/pull/1843)
- docs(plan): add #1845 usage cost share bug (https://github.com/stuarthopwood/refract/pull/1846)
- docs(plan): add #1847 to #1852 usage and app-wide polish (https://github.com/stuarthopwood/refract/pull/1853)
- docs(plan): add #1854 to #1856 session list, chat image, and shortcuts fixes (https://github.com/stuarthopwood/refract/pull/1857)
- chore(readout): resolve card collision boundary in a layout effect; harden verify-700 script (https://github.com/stuarthopwood/refract/pull/1821)
- docs(plan): split #1304 into child issues (https://github.com/stuarthopwood/refract/pull/1863)
- docs(plan): add #1864 and #1865, fold #698 and #479 (https://github.com/stuarthopwood/refract/pull/1866)
- docs(agents): open and merge every PR through gh stack (https://github.com/stuarthopwood/refract/pull/1869)
- docs(plan): file #1867 stacked pull requests setting (https://github.com/stuarthopwood/refract/pull/1870)
- chore(deps-dev): bump vite from 7.3.6 to 7.3.7 in the npm_and_yarn group across 1 directory (https://github.com/stuarthopwood/refract/pull/1868)
- docs(plan): file #1872 to #1880 UI feedback (https://github.com/stuarthopwood/refract/pull/1881)
- docs(plan): file #1882 chart tooltips (https://github.com/stuarthopwood/refract/pull/1883)
- docs(agents): run git switch -c before gh stack init in a detached worktree (https://github.com/stuarthopwood/refract/pull/1884)
- docs(plan): file #1885 theme file schema (https://github.com/stuarthopwood/refract/pull/1886)
- docs(agent-sessions): record the real omp check for #1193 (https://github.com/stuarthopwood/refract/pull/1887)
- docs(plan): mark #1193 done and add #1888 (https://github.com/stuarthopwood/refract/pull/1889)
- docs(plan): file #1890 pause and stopped Sessions (https://github.com/stuarthopwood/refract/pull/1891)
- docs(plan): file #1892 starting notice blur (https://github.com/stuarthopwood/refract/pull/1893)
- docs(plan): file #1901 performance epic and children (https://github.com/stuarthopwood/refract/pull/1903)
- docs(plan): file #1918 Road to V1 epic (https://github.com/stuarthopwood/refract/pull/1919)
- docs(agents): lift the no-new-tests prototyping rule for V1 (https://github.com/stuarthopwood/refract/pull/1920)

## v0.31.0 (2026-11-09)

### Features

- feat(issues): focusable label overflow chip with tooltip (https://github.com/stuarthopwood/refract/pull/1772)
- feat(readiness): three-step stepper on launch failure and a larger logo (https://github.com/stuarthopwood/refract/pull/1825)
- feat(session-list): start list filters after three characters (https://github.com/stuarthopwood/refract/pull/1824)
- feat(readiness): horizontal three-step stepper on every launch (https://github.com/stuarthopwood/refract/pull/1830)

### Fixes

- fix(worktree): guard git readers against worktree deletion (https://github.com/stuarthopwood/refract/pull/1763)
- fix(pull-requests): make Merge the filled primary action in the PR header (https://github.com/stuarthopwood/refract/pull/1771)
- fix(worktree): match reaper process paths on a name boundary at both ends (https://github.com/stuarthopwood/refract/pull/1783)
- fix(chat): announce readout hover cards on keyboard focus (https://github.com/stuarthopwood/refract/pull/1782)
- fix(a11y): guard the chat card background contrast pair (https://github.com/stuarthopwood/refract/pull/1820)
- fix(pull-requests): render linked images in PR descriptions (https://github.com/stuarthopwood/refract/pull/1784)
- fix(chat): drop the card footer band so actions sit on the card (https://github.com/stuarthopwood/refract/pull/1823)

### Other

- docs(plan): add the built-in browser epic, API tool, and loading page polish (https://github.com/stuarthopwood/refract/pull/1805)
- refactor(ipc): extract repository lookup, remote and required-arg helpers (https://github.com/stuarthopwood/refract/pull/1770)
- chore(build): prune stale file-size baseline entries (https://github.com/stuarthopwood/refract/pull/1781)
- docs(plan): add filters, slash commands, prompt templates, hooks, docs site, and tests epic (https://github.com/stuarthopwood/refract/pull/1816)
- docs(plan): add #1817 and #1818 (https://github.com/stuarthopwood/refract/pull/1819)
- docs(plan): remove stray conflict marker (https://github.com/stuarthopwood/refract/pull/1822)
- docs(plan): add #1827 (https://github.com/stuarthopwood/refract/pull/1828)
- docs(plan): add the OMP 18.18 review row, #1831 and #1832 (https://github.com/stuarthopwood/refract/pull/1833)
- docs(plan): raise #1254 to p1 (https://github.com/stuarthopwood/refract/pull/1834)
- docs(plan): add #1835 pause subagents bug (https://github.com/stuarthopwood/refract/pull/1836)

## v0.30.0 (2026-11-09)

### Features

- feat(triage): four-level p0-p3 priority scheme (https://github.com/stuarthopwood/refract/pull/1720)
- feat(cache): add pnpm cache:sweep and warn on a large shared cargo target (https://github.com/stuarthopwood/refract/pull/1754)

### Fixes

- fix(triage): cap keyword fallback priority at p1 (https://github.com/stuarthopwood/refract/pull/1738)
- fix(readiness): warn only on OMP newer than the tested 18.17.x line (https://github.com/stuarthopwood/refract/pull/1755)
- fix(sessions): refuse resume and attach for archived sessions (https://github.com/stuarthopwood/refract/pull/1764)
- fix(settings): write token guard settings to OMP global config (https://github.com/stuarthopwood/refract/pull/1780)

### Other

- docs(plan): add 2026-11-06 follow-up issues (https://github.com/stuarthopwood/refract/pull/1737)
- chore(deps): bump actions-rust-lang/setup-rust-toolchain from 2.0.0 to 2.0.1 (https://github.com/stuarthopwood/refract/pull/1704)
- docs(plan): raise #3 built-in terminal to P0 (https://github.com/stuarthopwood/refract/pull/1739)
- docs(plan): add #1740-#1743 UI polish filings (https://github.com/stuarthopwood/refract/pull/1744)
- docs(plan): add #1745 header badge filing (https://github.com/stuarthopwood/refract/pull/1746)
- docs(plan): add #1747 expanded Ask answers filing (https://github.com/stuarthopwood/refract/pull/1748)
- docs(plan): add OMP 18.17.0 review row and #1749, #1750 (https://github.com/stuarthopwood/refract/pull/1751)
- docs(tokens): converge spec 121 with OMP 18.17.0 subagent budget (https://github.com/stuarthopwood/refract/pull/1752)
- docs(context): add batch glossary terms (https://github.com/stuarthopwood/refract/pull/1753)
- docs(plan): add #1756 Subagents card Stage collapse and title width (https://github.com/stuarthopwood/refract/pull/1757)
- docs(plan): add #1758 Tool targets setting (https://github.com/stuarthopwood/refract/pull/1759)
- docs(plan): add #1760 Session details card delay and click suppression (https://github.com/stuarthopwood/refract/pull/1761)
- docs(context): add Sweep term (https://github.com/stuarthopwood/refract/pull/1762)
- docs(plan): add #1765 live-apply token guard settings (https://github.com/stuarthopwood/refract/pull/1766)
- docs(plan): add #1767 token guard writes global config (https://github.com/stuarthopwood/refract/pull/1768)
- docs(design): Refract is the driver, OMP the engine (https://github.com/stuarthopwood/refract/pull/1769)
- docs(plan): add #1774 (https://github.com/stuarthopwood/refract/pull/1775)
- docs(plan): add #1776 (https://github.com/stuarthopwood/refract/pull/1777)
- docs(plan): add #1778 and raise #1169 to p1 (https://github.com/stuarthopwood/refract/pull/1779)
- docs(plan): raise #1155 to p1 and add #1789 (https://github.com/stuarthopwood/refract/pull/1790)
- docs(agents): allow new Rust tests while prototyping (https://github.com/stuarthopwood/refract/pull/1791)
- build(tauri): disable incremental and trim dev debug info to shrink the shared cargo cache (https://github.com/stuarthopwood/refract/pull/1792)

## v0.29.0 (2026-11-06)

### Features

- feat(usage): ingest Copilot CLI credits per session (https://github.com/stuarthopwood/refract/pull/1707)
- feat(notifications): sounds for session notifications and alarms (https://github.com/stuarthopwood/refract/pull/1710)
- feat(shell): zoom in, out and reset with Ctrl+=, Ctrl+- and Ctrl+0 (https://github.com/stuarthopwood/refract/pull/1718)
- feat(renderer): clearer, dismissible toasts with severity icons (https://github.com/stuarthopwood/refract/pull/1719)

### Fixes

- fix(chat): only short mid-turn narration collapses to a Note row (https://github.com/stuarthopwood/refract/pull/1695)
- fix(usage): show Loading until the first scan completes (https://github.com/stuarthopwood/refract/pull/1697)
- fix(sessions): add Start agent to the Session row menu (https://github.com/stuarthopwood/refract/pull/1696)
- fix(settings): say each call costs AI credits in the file-read limit tip (https://github.com/stuarthopwood/refract/pull/1699)
- fix(token-guard): collapse repeated warnings and pause shake after omp pauses maintenance (https://github.com/stuarthopwood/refract/pull/1698)
- fix(repositories): compute remote kind eagerly in repositories.add (https://github.com/stuarthopwood/refract/pull/1705)
- fix(chat): share a translucent card background for subagent and ask cards (https://github.com/stuarthopwood/refract/pull/1706)
- fix(readout): treat gh api fields, query strings and repo placeholders as PR writes (https://github.com/stuarthopwood/refract/pull/1708)
- fix(chat): do not draw virtual, ~ and UNC write targets as file links (https://github.com/stuarthopwood/refract/pull/1709)
- fix(sessions): refuse agent start while Session delete is in flight (https://github.com/stuarthopwood/refract/pull/1712)
- fix(chat): keep the Todo card closed while the session has no plan (https://github.com/stuarthopwood/refract/pull/1711)
- fix(readout): keep the subagents panel link out of the tab order (https://github.com/stuarthopwood/refract/pull/1713)
- fix(readout): finish the readout chip verify scripts and card refs (https://github.com/stuarthopwood/refract/pull/1714)
- fix(installer): brand NSIS header, sidebar and uninstaller icon (https://github.com/stuarthopwood/refract/pull/1717)

### Other

- docs(plan): mark the 2026-11-05 batch done (https://github.com/stuarthopwood/refract/pull/1694)
- docs(plan): mark #1658, #1663, #1678, #1680 done (https://github.com/stuarthopwood/refract/pull/1700)
- docs(plan): mark #1669 done, add #1701 and #1702 (https://github.com/stuarthopwood/refract/pull/1703)
- chore(tests): clean up Rust test temp dirs with tempfile (https://github.com/stuarthopwood/refract/pull/1715)
- chore(renderer): remove Electron-only leftovers (https://github.com/stuarthopwood/refract/pull/1716)

## v0.28.0 (2026-11-05)

### Features

- feat(token-guard): cut prompt cache writes (https://github.com/stuarthopwood/refract/pull/1684)
- feat(chat): mute inline code chips in chat messages (https://github.com/stuarthopwood/refract/pull/1688)
- feat(1646): NumberField muted chevron step buttons with an 8px gap (https://github.com/stuarthopwood/refract/pull/1685)
- feat(ui): fainter brand watermark with holiday glyph in transcripts (https://github.com/stuarthopwood/refract/pull/1689)
- feat(chat): render OMP command output as Markdown with a usage card (https://github.com/stuarthopwood/refract/pull/1690)
- feat(chat): subagents card tree rail with elbows (https://github.com/stuarthopwood/refract/pull/1692)

### Fixes

- fix(1651): remove the border from the Paused card (https://github.com/stuarthopwood/refract/pull/1686)
- fix(usage): start ingest at app launch (https://github.com/stuarthopwood/refract/pull/1687)
- fix(chat): keep async task subagents running after spawn (https://github.com/stuarthopwood/refract/pull/1691)
- fix(usage): re-ingest session files rewritten past the first 256 bytes (https://github.com/stuarthopwood/refract/pull/1693)

### Other

- docs(plan): mark batch of 10 done (https://github.com/stuarthopwood/refract/pull/1677)
- docs(plan): add #1678 (https://github.com/stuarthopwood/refract/pull/1679)
- docs(plan): add #1680 (https://github.com/stuarthopwood/refract/pull/1681)
- docs(plan): add #1682 (https://github.com/stuarthopwood/refract/pull/1683)

## v0.27.0 (2026-11-04)

### Features

- feat(chat): render tool row targets as shared inline-code chips (https://github.com/stuarthopwood/refract/pull/1645)
- feat(usage): averages section (https://github.com/stuarthopwood/refract/pull/1643)
- feat(settings): optimise token usage button (https://github.com/stuarthopwood/refract/pull/1661)
- feat(chat): header badge tracks Session-written PRs and issues (https://github.com/stuarthopwood/refract/pull/1644)
- feat(themes): six new themes (https://github.com/stuarthopwood/refract/pull/1653)
- feat(lists): refresh PR and issue lists after a merge, close or Session write (https://github.com/stuarthopwood/refract/pull/1675)

### Fixes

- fix(chat): line up transcript row chevrons with an in-row action gutter (https://github.com/stuarthopwood/refract/pull/1674)
- fix(usage): show Project for worktree and scratch cwds (https://github.com/stuarthopwood/refract/pull/1676)

### Other

- docs(plan): file #1641 (stale verify scripts) (https://github.com/stuarthopwood/refract/pull/1642)
- docs(remote): spike OMP /collab over RPC and security assessment (https://github.com/stuarthopwood/refract/pull/1649)
- docs(plan): file #1646, #1647 and #1648 (number field, watermark, command output) (https://github.com/stuarthopwood/refract/pull/1650)
- docs(plan): file #1651 (pause card border) (https://github.com/stuarthopwood/refract/pull/1652)
- docs(plan): block #1639 on OMP RPC collab (#18079) (https://github.com/stuarthopwood/refract/pull/1654)
- docs(plan): add usage credit gap issues #1655 to #1658 (https://github.com/stuarthopwood/refract/pull/1659)
- chore(config): hide off-topic skills in Refract sessions (https://github.com/stuarthopwood/refract/pull/1660)
- docs(plan): add #1663 and #1664 (https://github.com/stuarthopwood/refract/pull/1665)
- docs(plan): add #1666 (https://github.com/stuarthopwood/refract/pull/1667)
- docs(plan): promote #1304 to P0 (https://github.com/stuarthopwood/refract/pull/1668)
- docs(plan): add #1669 (https://github.com/stuarthopwood/refract/pull/1670)
- chore(verify): repair stale verify scripts after batch 2 polish (https://github.com/stuarthopwood/refract/pull/1662)
- docs(plan): add #1672 (https://github.com/stuarthopwood/refract/pull/1673)

## Unreleased

### Features

- feat(lists): PR list, Issues list and Home counts refresh quietly after a merge or close in the app or by a Session agent, through a `github:changed` event (#1589)
- fix(chat): every transcript row's chevron lines up in one column: the action gutter now sits inside each expandable row's hover surface, so tool rows no longer end 28px short of thought, note and asked-user rows, and the hover fill covers the full row (#1612, https://github.com/stuarthopwood/refract/pull/1674)
- feat(themes): six new themes, the first light ones: Light, Light (warm paper), Light (high contrast), Lagoon, Amethyst and Hearth (#1590, https://github.com/stuarthopwood/refract/pull/1653)
- feat(cache): `pnpm cache:sweep` prunes shared cargo target artefacts unused for 7+ days (pinned cargo-sweep, refuses while a build holds the lock); `pnpm ci:local` warns when the target passes 10 GB and defaults `CARGO_INCREMENTAL=0` (#1736, https://github.com/stuarthopwood/refract/pull/1754)

### Bug Fixes

- fix(usage): worktree and scratch cwds show their Project (or one **Other** row) in every Usage section and the Project filter, and session folders without a cwd are matched too; stored rows are relabelled in place (#1571)

## v0.26.0 (2026-11-03)

### Features

- feat(ui): palette search field and icons, collapsible session filter (https://github.com/stuarthopwood/refract/pull/1634)

### Fixes

- fix(ui): list-row kebab inside the card and ToggleGroup review verdicts (https://github.com/stuarthopwood/refract/pull/1632)
- fix(chat): themed alarm time field, role card tints, Session click opens chat (https://github.com/stuarthopwood/refract/pull/1633)
- fix(chat): polish status icon, link copy button and ask card footer (https://github.com/stuarthopwood/refract/pull/1631)

### Other

- docs(plan): mark batch 2 polish rows done (https://github.com/stuarthopwood/refract/pull/1635)

## v0.25.0 (2026-11-03)

### Features

- feat(chat): chat navigation map and one 6px scrollbar token (#1541, #1542) (https://github.com/stuarthopwood/refract/pull/1628)
- feat(settings): role picker Main group, role badges, agent wording (#1549, #1550, #1551) (https://github.com/stuarthopwood/refract/pull/1627)

### Other

- docs(plan): file #1621 (restart during delete race) (https://github.com/stuarthopwood/refract/pull/1625)
- style(ui): rail icons, small Switch, Budget border (#1557, #1558, #1566) (https://github.com/stuarthopwood/refract/pull/1626)
- style(ui): list cards use a surface-subtle fill, no border (#1560) (https://github.com/stuarthopwood/refract/pull/1629)
- style(ui): ghost buttons app-wide (#1564) (https://github.com/stuarthopwood/refract/pull/1630)

## v0.24.0 (2026-11-03)

### Features

- feat(settings): Settings > Advanced percent thresholds, number fields, plain copy and impact warnings (https://github.com/stuarthopwood/refract/pull/1601)
- feat(sessions): delete Session in the background (https://github.com/stuarthopwood/refract/pull/1609)

### Fixes

- fix(ui): polish batch (#1597, #1596, #1598, #1585) (https://github.com/stuarthopwood/refract/pull/1608)

### Other

- docs(plan): file #1579-#1581 advanced settings token items (p1) (https://github.com/stuarthopwood/refract/pull/1582)
- docs(plan): file #1583 tool row target chips (p1) (https://github.com/stuarthopwood/refract/pull/1584)
- docs(plan): file #1585 todo mute after current (p1) (https://github.com/stuarthopwood/refract/pull/1586)
- docs(plan): file #1587 session-touched PR and issue badge (p1) (https://github.com/stuarthopwood/refract/pull/1588)
- docs(plan): file #1589-#1591 list refresh, themes, background delete (https://github.com/stuarthopwood/refract/pull/1592)
- docs(plan): amend #1583 with chat tool row indentation fixes (https://github.com/stuarthopwood/refract/pull/1593)
- docs(plan): file #1594 command palette search field and icons (p1) (https://github.com/stuarthopwood/refract/pull/1595)
- docs(plan): file #1596-#1598 and amend #137 (select accent, stopped icon, status bar, settings logo) (https://github.com/stuarthopwood/refract/pull/1599)
- docs(plan): amend #1564 ghost buttons to cover shared outline defaults (https://github.com/stuarthopwood/refract/pull/1600)
- docs(plan): Settings > Advanced batch done (#1553, #1555, #1579, #1580) (https://github.com/stuarthopwood/refract/pull/1602)
- docs(plan): file #1603 and amend #1304 (session click switch, agent session control) (https://github.com/stuarthopwood/refract/pull/1604)
- docs(plan): file #1605 and #1606 (chat copy link button, ask card footer and hints) (https://github.com/stuarthopwood/refract/pull/1607)
- docs(plan): file #1610 (session list filter behind a funnel icon) (https://github.com/stuarthopwood/refract/pull/1611)
- docs(plan): file #1612 (align transcript row chevrons) (https://github.com/stuarthopwood/refract/pull/1613)
- docs(plan): file #1614 and amend #1612 (row menus inside the hover surface) (https://github.com/stuarthopwood/refract/pull/1615)
- docs(plan): file #1616 (themed alarm TimeField) (https://github.com/stuarthopwood/refract/pull/1617)
- docs(plan): amend #1560 list cards with a resting surface-subtle fill (https://github.com/stuarthopwood/refract/pull/1618)
- docs(plan): file #1619 (status line state icon) (https://github.com/stuarthopwood/refract/pull/1620)

## v0.23.0 (2026-11-02)

### Features

- feat(au): composer working-mode menu (Interactive, Plan, Grill, Away) (https://github.com/stuarthopwood/refract/pull/1574)

### Other

- style(av): one option-button and tab look app-wide (https://github.com/stuarthopwood/refract/pull/1570)
- docs(plan): file #1571 usage project labels (p1) (https://github.com/stuarthopwood/refract/pull/1572)
- docs(plan): amend #1571 to cover the usage project filter (https://github.com/stuarthopwood/refract/pull/1573)
- docs(plan): file #1575 review dialog verdict picker (p1) (https://github.com/stuarthopwood/refract/pull/1576)
- docs(plan): file #1577 composer role cards (p1) (https://github.com/stuarthopwood/refract/pull/1578)

## v0.22.0 (2026-11-02)

### Features

- feat(design): design sweep leftovers (https://github.com/stuarthopwood/refract/pull/1535)
- feat(at): token guard read and todo defaults, prewalk and plan mode settings (https://github.com/stuarthopwood/refract/pull/1563)

### Fixes

- fix(holiday): holiday touches follow-ups (https://github.com/stuarthopwood/refract/pull/1537)
- fix(watermark): brand watermark follow-ups (https://github.com/stuarthopwood/refract/pull/1539)
- fix(composer): context menu follow-ups (https://github.com/stuarthopwood/refract/pull/1540)

### Other

- docs(plan): place #1541 and #1542 scrollbar polish (https://github.com/stuarthopwood/refract/pull/1543)
- chore(skills): add compare-token-usage skill for Refract sessions (https://github.com/stuarthopwood/refract/pull/1544)
- docs(plan): add P0 rows for #1545 and #695 (https://github.com/stuarthopwood/refract/pull/1546)
- docs(plan): add P1 row for #433 working-mode menu (https://github.com/stuarthopwood/refract/pull/1547)
- docs(plan): amend #1302 option buttons and tabs to one look (p1) (https://github.com/stuarthopwood/refract/pull/1548)
- docs(plan): file #1549, #1550, #1551 role picker and OMP wording (p1) (https://github.com/stuarthopwood/refract/pull/1552)
- docs(plan): file #1553 compaction thresholds as a percentage (p1) (https://github.com/stuarthopwood/refract/pull/1554)
- docs(plan): file #1555 Settings Advanced descriptions (p1) (https://github.com/stuarthopwood/refract/pull/1556)
- docs(plan): file #1557 rail icon colour and #1558 small switch (p1) (https://github.com/stuarthopwood/refract/pull/1559)
- docs(plan): file #1560 Home borderless list cards (p1) (https://github.com/stuarthopwood/refract/pull/1561)
- docs(plan): file #1564 ghost buttons app-wide (p1) (https://github.com/stuarthopwood/refract/pull/1565)

## v0.21.0 (2026-10-31)

### Features

- feat(sessions): new session from an issue or pull request with a write-access-gated kickoff (https://github.com/stuarthopwood/refract/pull/1517)

### Fixes

- fix(gate-leftovers): harden updater install log and spec 090 leftovers (https://github.com/stuarthopwood/refract/pull/1522)
- fix(ui): spec 088 UI polish leftovers (https://github.com/stuarthopwood/refract/pull/1523)
- fix(issues): issue and pull request list follow-ups (https://github.com/stuarthopwood/refract/pull/1526)
- fix(chat): header PR badge follow-ups (https://github.com/stuarthopwood/refract/pull/1528)
- fix(palette): palette slice 2 follow-ups (UK Backslash chord, repo labels) (https://github.com/stuarthopwood/refract/pull/1529)
- fix(themes): spec 086 gate leftovers (https://github.com/stuarthopwood/refract/pull/1531)

### Other

- refactor(composer-focus): shared input-with-action and focus follow-ups (https://github.com/stuarthopwood/refract/pull/1516)
- refactor(gate-leftovers): centralise disabled button styling and spec 091 leftovers (https://github.com/stuarthopwood/refract/pull/1519)
- chore(design): gate-script residual limits (https://github.com/stuarthopwood/refract/pull/1532)

## v0.20.0 (2026-10-31)

### Features

- feat(chat-header): PR and issue badges with pinned right-pane panels (https://github.com/stuarthopwood/refract/pull/1512)

### Fixes

- fix(gate-leftovers): spec 085 and 087 gate follow-ups (https://github.com/stuarthopwood/refract/pull/1505)
- fix(gate-leftovers): updater hand-off, spellcheck and suspect-window follow-ups (https://github.com/stuarthopwood/refract/pull/1506)
- fix(issues): New issue title, cross-Project PR count and list follow-ups (https://github.com/stuarthopwood/refract/pull/1509)
- fix(composer-focus): stop-banner focus handoff and masked extension secret input (https://github.com/stuarthopwood/refract/pull/1510)
- fix(composer): Tab indents, Ctrl+M focus toggle and list continuation (https://github.com/stuarthopwood/refract/pull/1513)

## v0.19.0 (2026-10-31)

### Features

- feat(design): derive Mermaid, Shiki and scrollbar colours from theme tokens (https://github.com/stuarthopwood/refract/pull/1493)
- feat(gate-followups): spec 068 and 070 gate follow-ups for usage, roster, session list and settings (https://github.com/stuarthopwood/refract/pull/1496)
- feat(themes): theme contrast gate covers derived tokens, shared theme entries and row menu fixes (https://github.com/stuarthopwood/refract/pull/1498)
- feat(ui): PR and issue detail header polish, invalid field ring and shared select defaults (https://github.com/stuarthopwood/refract/pull/1502)

### Fixes

- fix(gate-leftovers): reason tooltips on disabled buttons and spec 082 Lows (https://github.com/stuarthopwood/refract/pull/1494)

### Other

- chore(design): harden literal-colour and comment-density gates (https://github.com/stuarthopwood/refract/pull/1500)

## v0.18.0 (2026-10-31)

### Features

- feat(design): icon buttons, hit targets and translucent tokens (#579) (https://github.com/stuarthopwood/refract/pull/1475)
- feat(profile): finish profile menu and account management (spec 008) (https://github.com/stuarthopwood/refract/pull/1478)
- feat(theming): custom theme files, contrast warnings and reset (#458) (https://github.com/stuarthopwood/refract/pull/1480)
- feat(design): design sweep slices D-F (https://github.com/stuarthopwood/refract/pull/1483)
- feat(design): per-element theme tokens and theme leftovers (https://github.com/stuarthopwood/refract/pull/1487)

### Fixes

- fix(chat): gate follow-ups for specs 075, 076 and 008 (https://github.com/stuarthopwood/refract/pull/1484)
- fix(gate-leftovers): close #1481 and #1482 gate leftovers (https://github.com/stuarthopwood/refract/pull/1489)

### Other

- refactor(ui): migrate remaining confirm dialogs and polish transcript menus (https://github.com/stuarthopwood/refract/pull/1471)
- chore(design): enforce no literal colours in the renderer (https://github.com/stuarthopwood/refract/pull/1490)

## v0.17.0 (2026-10-30)

### Features

- feat(filters): issue label filter, session usage panel and advisor roster (https://github.com/stuarthopwood/refract/pull/1455)
- feat(chat): transcript context menus for messages, code, tools and diagrams (https://github.com/stuarthopwood/refract/pull/1456)
- feat(chat): composer alarm clock, Advisor tag sizing and Subagent role label (https://github.com/stuarthopwood/refract/pull/1458)
- feat(chat): alarm clock polish, border-only subagent chain card, stable fs watch test (https://github.com/stuarthopwood/refract/pull/1464)

### Fixes

- fix(chat): Subagents chain card treatment and settled Stage status (https://github.com/stuarthopwood/refract/pull/1460)

### Other

- refactor(ui): shared InlineStatus and ConfirmAlertDialog for status text and confirm dialogs (https://github.com/stuarthopwood/refract/pull/1462)
- docs(plan): OMP 18.14.0 review and re-verify (https://github.com/stuarthopwood/refract/pull/1465)

## v0.16.0 (2026-10-30)

### Features

- feat(palette): command palette on a shared action registry (https://github.com/stuarthopwood/refract/pull/1415)
- feat(palette): move menus and chords onto the action registry (https://github.com/stuarthopwood/refract/pull/1440)

### Fixes

- fix(chat): Previous past Notes, suspect context window warning, Usage spacing (https://github.com/stuarthopwood/refract/pull/1442)
- fix(pull-requests): detail and filter polish for pull requests and issues (https://github.com/stuarthopwood/refract/pull/1444)
- fix(session-list): session list and settings polish (https://github.com/stuarthopwood/refract/pull/1447)
- fix(ui): app-wide polish for pickers, fields, buttons and chrome (https://github.com/stuarthopwood/refract/pull/1450)
- fix(updater): loud install hand-off, composer spelling, Question card polish (https://github.com/stuarthopwood/refract/pull/1451)
- fix(git): give diff_stat tests a 30 s budget under parallel load (https://github.com/stuarthopwood/refract/pull/1453)

### Other

- chore(renderer): cut src/renderer and src/shared comments to why-only (#1322) (https://github.com/stuarthopwood/refract/pull/1384)
- docs(plan): add top chrome issue #1385 (https://github.com/stuarthopwood/refract/pull/1386)
- docs(plan): add action buttons issue #1387 (https://github.com/stuarthopwood/refract/pull/1388)
- docs(plan): add PR view dividers issue #1389 (https://github.com/stuarthopwood/refract/pull/1390)
- docs(plan): add picker width issue #1391 (https://github.com/stuarthopwood/refract/pull/1392)
- docs(plan): add hide merged PR actions issue #1393 (https://github.com/stuarthopwood/refract/pull/1394)
- docs(plan): add #1395 quiet text fields line (https://github.com/stuarthopwood/refract/pull/1396)
- docs(plan): add #1397 copy link icon line (https://github.com/stuarthopwood/refract/pull/1398)
- docs(plan): add #1399 and #1400 select picker lines (https://github.com/stuarthopwood/refract/pull/1401)
- docs(plan): add #1402 session usage panel line (https://github.com/stuarthopwood/refract/pull/1403)
- docs(plan): add #1404 and #1405 context menu lines (https://github.com/stuarthopwood/refract/pull/1406)
- docs(plan): add #1407 usage section spacing line (https://github.com/stuarthopwood/refract/pull/1408)
- docs(plan): add #1409 advisor roster line (https://github.com/stuarthopwood/refract/pull/1410)
- docs(plan): add #1411 context window warning line (https://github.com/stuarthopwood/refract/pull/1412)
- docs(plan): add #1413 previous message note line (https://github.com/stuarthopwood/refract/pull/1414)
- docs(plan): add #1416 hidden toggle line, correct #1413 cause (https://github.com/stuarthopwood/refract/pull/1417)
- docs(plan): add #1418 session card ghost buttons line (https://github.com/stuarthopwood/refract/pull/1419)
- docs(plan): add #1420 reveal action wording line (https://github.com/stuarthopwood/refract/pull/1421)
- docs(plan): add #1422 header hover line (https://github.com/stuarthopwood/refract/pull/1423)
- docs(plan): add #1424 appearance autosave line (https://github.com/stuarthopwood/refract/pull/1425)
- docs(plan): add #1426 composer clock alarms line (https://github.com/stuarthopwood/refract/pull/1427)
- docs(plan): add #1428-#1437 UI feedback batch lines (https://github.com/stuarthopwood/refract/pull/1438)

## v0.15.0 (2026-10-30)

### Features

- feat(chat): pause mode (#477) (https://github.com/stuarthopwood/refract/pull/1354)
- feat(pull-requests): cross-Project Pull requests view on the shared list shell (https://github.com/stuarthopwood/refract/pull/1357)
- feat(ui): subtle enter-only switching animations app-wide (https://github.com/stuarthopwood/refract/pull/1362)
- feat(session-list): Home view with needs-you, recent, PRs, issues and tidy-up (https://github.com/stuarthopwood/refract/pull/1364)
- feat(usage): usage.db ingest, rollups and usage IPC (slice 1 of 2) (https://github.com/stuarthopwood/refract/pull/1366)
- feat(usage): usage view (slice 2 of 2) (https://github.com/stuarthopwood/refract/pull/1367)
- feat(holidays): Bonfire Night, Christmas, New Year, Star Wars Day and Pi Day (#1048) (https://github.com/stuarthopwood/refract/pull/1375)
- feat(composer): right-click context menu with Cut, Copy, Paste, Paste as plain text, Select all (https://github.com/stuarthopwood/refract/pull/1379)
- feat(themes): display-profile luminance audit script (#553) (https://github.com/stuarthopwood/refract/pull/1382)

### Fixes

- fix(ui): move Approval pill and Model picker onto the shared radio mark (https://github.com/stuarthopwood/refract/pull/1359)
- fix(sessions): Manage sessions reuses the shared Session row (#934) (https://github.com/stuarthopwood/refract/pull/1372)

### Other

- chore(settings): live-verify the brand watermark (#406) (https://github.com/stuarthopwood/refract/pull/1365)
- chore(gates): add the why-only comment rule and check:comment-density gate (#1322) (https://github.com/stuarthopwood/refract/pull/1371)
- chore(rust): cut src-tauri comments to why-only (#1322) (https://github.com/stuarthopwood/refract/pull/1376)
- chore(scripts): cut scripts comments to why-only (#1322) (https://github.com/stuarthopwood/refract/pull/1378)

## v0.14.0 (2026-10-30)

### Features

- feat(session-list): hide a Session without archiving it (#748) (https://github.com/stuarthopwood/refract/pull/1329)
- feat(chat): degraded-only RPC slow and agent memory readouts (https://github.com/stuarthopwood/refract/pull/1334)
- feat(session-list): agents button with a running count on each Session row (#507) (https://github.com/stuarthopwood/refract/pull/1336)
- feat(chat): non-agent row verb emphasis and Tight/Compact/Comfy row density (#1300) (https://github.com/stuarthopwood/refract/pull/1340)
- feat(session-list): report an issue from the repository menu (#503) (https://github.com/stuarthopwood/refract/pull/1342)
- feat(chat): live Markdown styling in the composer (#1170) (https://github.com/stuarthopwood/refract/pull/1344)
- feat(chat): shake actions on the Context usage readout (#506) (https://github.com/stuarthopwood/refract/pull/1345)
- feat(session-list): issues page and GitHub tools block (#504) (https://github.com/stuarthopwood/refract/pull/1346)
- feat(chat): theme tokens for Markdown, syntax and Mermaid from each theme's accent (https://github.com/stuarthopwood/refract/pull/1348)
- feat(chat): ghost Copy button and context menus on chat links (https://github.com/stuarthopwood/refract/pull/1350)
- feat(session-list): add project flyout and clone from GitHub (#867) (https://github.com/stuarthopwood/refract/pull/1352)
- feat(session-list): rename Repository to Project in UI text (#867) (https://github.com/stuarthopwood/refract/pull/1355)

### Fixes

- fix(chat): retune watermark and Halloween opacity to 1.6:1, show Compacting for manual /compact (https://github.com/stuarthopwood/refract/pull/1338)

## v0.13.0 (2026-10-29)

### Features

- feat(ui): app-wide design tokens (wave 1) (https://github.com/stuarthopwood/refract/pull/1303)
- feat(explorer): right pane resize and surface, rail sizing, row actions, git colours (https://github.com/stuarthopwood/refract/pull/1309)
- feat(settings): grouped Settings pages, Advanced, role colours, text sizes (https://github.com/stuarthopwood/refract/pull/1312)
- feat(sessions): session list wave 2 (status style, project colour, group headers, manage sessions) (https://github.com/stuarthopwood/refract/pull/1313)
- feat(composer): shared ComposerBox, queued panel, split Approve, Ask and remember, background agents banner (https://github.com/stuarthopwood/refract/pull/1318)
- feat(pull-requests): timeline restyle, rich comment editor and Checks section (https://github.com/stuarthopwood/refract/pull/1320)
- feat(chat): wave 3 chat transcript bundle (retry, banners, tool rows, focus tint) (https://github.com/stuarthopwood/refract/pull/1321)
- feat(chat): chat navigation — step, outline, find and scrollbar map (https://github.com/stuarthopwood/refract/pull/1324)
- feat(chat): show the user's GitHub avatar on their messages (https://github.com/stuarthopwood/refract/pull/1327)

### Fixes

- fix(agents): trust the OS certificate store at every agent start (https://github.com/stuarthopwood/refract/pull/1319)
- fix(halloween): keep artwork out of the text column, fade bats on pause, harden verify script (https://github.com/stuarthopwood/refract/pull/1326)

### Other

- docs(plan): OMP 18.13.3 review row (https://github.com/stuarthopwood/refract/pull/1297)
- docs(plan): add watermark opacity polish issue #1298 (https://github.com/stuarthopwood/refract/pull/1299)
- docs(plan): add chat row density issue #1300 (https://github.com/stuarthopwood/refract/pull/1301)
- docs(plan): file #1304 child Sessions and add the Child Session term (https://github.com/stuarthopwood/refract/pull/1305)
- docs(plan): pause mode, command palette, chat tree, new session from issue (https://github.com/stuarthopwood/refract/pull/1311)
- docs(plan): chat header PR and issue badges (#1315) (https://github.com/stuarthopwood/refract/pull/1316)
- docs(plan): comment cull and comment-density gate (#1322) (https://github.com/stuarthopwood/refract/pull/1323)
- docs(plan): file #1331 Usage view and ADR 0006 (https://github.com/stuarthopwood/refract/pull/1332)

## v0.12.1 (2026-10-28)

### Fixes

- fix(worktree): diff_stat no longer follows symlinks outside the worktree (https://github.com/stuarthopwood/refract/pull/1280)
- fix(chat): Stop returns queued messages to the composer (https://github.com/stuarthopwood/refract/pull/1281)
- fix(settings): keep focused reasoning radio mounted (#1127) (https://github.com/stuarthopwood/refract/pull/1282)
- fix(file-explorer): show keyboard focus ring on tree and preview (https://github.com/stuarthopwood/refract/pull/1288)
- fix(delete): honest wording and success on retry after a partial delete (https://github.com/stuarthopwood/refract/pull/1290)
- fix(updates): Update now counts live agents, verifies before quit, guards double quit (https://github.com/stuarthopwood/refract/pull/1291)
- fix(chat): refocus composer when Stop unmounts at turn end (https://github.com/stuarthopwood/refract/pull/1292)
- fix(delete): bound delete lock waits and use worktree-busy code (https://github.com/stuarthopwood/refract/pull/1293)

### Other

- docs: wave 1 tokens grill outcomes (https://github.com/stuarthopwood/refract/pull/1277)
- docs(plan): place #1283 and #1284 in wave 3; note #839 and #1267 amendments (https://github.com/stuarthopwood/refract/pull/1286)
- docs(plan): note #1287 beside #1284 in wave 3 (https://github.com/stuarthopwood/refract/pull/1289)

## v0.12.0 (2026-10-28)

### Features

- feat(right-pane): drag to rearrange rail buttons with keyboard alternative and new default order (https://github.com/stuarthopwood/refract/pull/1244)
- feat(chat): show attached images in the user message bubble (https://github.com/stuarthopwood/refract/pull/1245)
- feat(chat): collapse mid-turn assistant prose to a Note row (https://github.com/stuarthopwood/refract/pull/1261)
- feat(chat): accent, shimmer and larger composer status text (https://github.com/stuarthopwood/refract/pull/1257)
- feat(chat): remove banner timer, make finished turn totals optional (https://github.com/stuarthopwood/refract/pull/1264)
- feat(chat): show AI credits and plan usage in the Context usage readout (https://github.com/stuarthopwood/refract/pull/1263)
- feat(ui): Geist and Geist Mono defaults with lighter weight scale (https://github.com/stuarthopwood/refract/pull/1266)
- feat(ui): move the app to an 8px spacing grid (https://github.com/stuarthopwood/refract/pull/1269)

### Fixes

- fix(holiday): lift Halloween artwork to 3:1 and keep bat flight countdown across pauses (https://github.com/stuarthopwood/refract/pull/1255)
- fix(chat): split chip label first line on CR so CRLF pastes survive keystrokes (https://github.com/stuarthopwood/refract/pull/1259)

### Other

- docs(plan): add Halloween artwork visibility polish issue (https://github.com/stuarthopwood/refract/pull/1234)
- docs(plan): add #1235 and #1236, index #1233 (https://github.com/stuarthopwood/refract/pull/1237)
- docs(plan): add #1238 AI credits in context usage chip (https://github.com/stuarthopwood/refract/pull/1239)
- docs(plan): amend #1238 to the individual Copilot plan allowance (https://github.com/stuarthopwood/refract/pull/1240)
- docs(plan): note keystroke trigger on #1235 row (https://github.com/stuarthopwood/refract/pull/1241)
- docs(plan): add #1242 composer status text row (https://github.com/stuarthopwood/refract/pull/1243)
- docs(plan): add #1246 Geist and lighter weight scale row (https://github.com/stuarthopwood/refract/pull/1247)
- docs(plan): amend #1246 row with code ligatures default and toggle (https://github.com/stuarthopwood/refract/pull/1249)
- docs(plan): add #1250 row and mark session UI polish issues p1 (https://github.com/stuarthopwood/refract/pull/1251)
- docs(plan): add #1252 spacing 8px grid row (https://github.com/stuarthopwood/refract/pull/1253)
- docs(plan): record the 2026-10-28 P2 triage (https://github.com/stuarthopwood/refract/pull/1274)
- docs(plan): raise UI polish and design issues to p1 (https://github.com/stuarthopwood/refract/pull/1275)

## v0.11.0 (2026-10-26)

### Features

- feat(1208): lighter font weights and sentence-case action verbs (https://github.com/stuarthopwood/refract/pull/1223)
- feat(chat): tool-row icons, intent labels and raw-id tooltips (#469) (https://github.com/stuarthopwood/refract/pull/1227)
- feat(right-pane): collapse toggle, Ctrl+Shift+B, rail count badges and persistence (#538) (https://github.com/stuarthopwood/refract/pull/1231)
- feat(526): Session row Activity line with Plain/Playful activity text (https://github.com/stuarthopwood/refract/pull/1230)

### Other

- docs(plan): start #1208 and mark closed Priority order rows done (https://github.com/stuarthopwood/refract/pull/1221)
- docs(plan): fold the OMP to Advanced Settings rework into #714 (https://github.com/stuarthopwood/refract/pull/1222)
- docs(plan): #1208 done (PR #1223); place #1224 (https://github.com/stuarthopwood/refract/pull/1225)
- docs: trim AGENTS.md startup context (https://github.com/stuarthopwood/refract/pull/1228)
- docs: make CLAUDE.md import AGENTS.md (https://github.com/stuarthopwood/refract/pull/1229)

## v0.10.0 (2026-10-26)

### Breaking changes

- feat(1212)!: token guard launch overlay, shake, hand off and Refract rules (https://github.com/stuarthopwood/refract/pull/1215)

### Features

- feat(687): current-work banner above the composer (https://github.com/stuarthopwood/refract/pull/1202)
- feat(1205): open stopped Sessions without starting the agent (https://github.com/stuarthopwood/refract/pull/1218)

### Fixes

- fix(802): two vertical scrollbars in the Side chat panel when the answer is taller than the pane (https://github.com/stuarthopwood/refract/pull/1014)
- fix(release): drop inherited PSMODULEPATH case variants before the signature check (https://github.com/stuarthopwood/refract/pull/1192)
- fix(1200): contain sr-only alert so long PRs no longer scroll the document (https://github.com/stuarthopwood/refract/pull/1217)

### Other

- docs(plan): raise #513 to p1 (https://github.com/stuarthopwood/refract/pull/1191)
- chore(deps): bump actions/setup-node from 7.0.0 to 7.1.0 (https://github.com/stuarthopwood/refract/pull/890)
- docs(plan): place #1193 and #1194 (https://github.com/stuarthopwood/refract/pull/1195)
- docs(plan): place #915 and #1196 (https://github.com/stuarthopwood/refract/pull/1197)
- docs(plan): place #1198, #1199 and #1200; amend #915 and #1196 (https://github.com/stuarthopwood/refract/pull/1201)
- docs(plan): place #1203, #1204 and #1205 (https://github.com/stuarthopwood/refract/pull/1206)
- docs(plan): raise #1205 to p1 at priority 2 (https://github.com/stuarthopwood/refract/pull/1207)
- docs(plan): place #1208 before #469 (https://github.com/stuarthopwood/refract/pull/1209)
- docs(plan): place #1210 (https://github.com/stuarthopwood/refract/pull/1211)
- docs(plan): place P0 #1212 token guard first (https://github.com/stuarthopwood/refract/pull/1213)

## v0.9.0 (2026-10-22)

### Features

- feat(design-system): one selected-item style + Explorer text/icon tone (https://github.com/stuarthopwood/refract/pull/1153)
- feat(pull-requests): RAG check colours, State select height, state-only reason line, Open on GitHub button (https://github.com/stuarthopwood/refract/pull/1154)
- feat(chat): agent-to-agent line styling, /models command, delete-wait timeout (https://github.com/stuarthopwood/refract/pull/1161)
- feat(composer): image-only send, context-usage gradient, live branch label (https://github.com/stuarthopwood/refract/pull/1162)
- feat(chat): close-pane chat glyph and ghost New conversation button (https://github.com/stuarthopwood/refract/pull/1167)
- feat(installer): optional desktop shortcut on the finish page (https://github.com/stuarthopwood/refract/pull/1172)
- feat(updates): periodic check, background download and restart to update (https://github.com/stuarthopwood/refract/pull/1174)
- feat(rm): queue role, model and thinking changes while a turn runs (#766 part A) (https://github.com/stuarthopwood/refract/pull/1183)
- feat(rm): combined Role·Model pill, one switcher and Ctrl+R role cycling (#766 part B) (https://github.com/stuarthopwood/refract/pull/1187)
- feat(omp): OMP settings guard resets drifted token-cost settings (#1184) (https://github.com/stuarthopwood/refract/pull/1189)

### Fixes

- perf(chat): memoise transcript rows and markdown (https://github.com/stuarthopwood/refract/pull/1177)
- fix(worktrees): remove pnpm node_modules junctions before git worktree remove (https://github.com/stuarthopwood/refract/pull/1182)

### Other

- docs(plan): file #1155 chat item references with hover card (https://github.com/stuarthopwood/refract/pull/1156)
- docs(plan): 2026-10-22 priority review and p1 order (https://github.com/stuarthopwood/refract/pull/1160)
- docs(plan): working rule 13 director model and 2026-10-22 token-cost decisions (https://github.com/stuarthopwood/refract/pull/1166)
- docs(plan): place #1169 and #1170 (https://github.com/stuarthopwood/refract/pull/1171)
- chore(worktrees): add pnpm worktrees:reap and the post-merge reap step (https://github.com/stuarthopwood/refract/pull/1179)
- docs(plan): place #1184 OMP settings guard at priority 3 (https://github.com/stuarthopwood/refract/pull/1185)

## v0.8.0 (2026-10-21)

### Features

- feat(chat): Enter sends oldest queued follow-up on a blank composer (#1067) (https://github.com/stuarthopwood/refract/pull/1100)
- feat(1069): Model roles overhaul -- one provider switch, reasoning-level radios (https://github.com/stuarthopwood/refract/pull/1114)
- feat(700): Todo and Agents hover/focus cards, Rust taskSummary (Closes #700, Refs #701) (https://github.com/stuarthopwood/refract/pull/1118)

### Fixes

- fix(1101): Git changes panel UI polish (counter, composer inputs, busy state, untracked diff, sticky back) (https://github.com/stuarthopwood/refract/pull/1109)
- fix(1111): Git changes panel read-path hardening + polish (Closes #1111, Closes #1110) (https://github.com/stuarthopwood/refract/pull/1113)

### Other

- docs(plan): file Git changes panel feedback (#1101, #1102), amend #730 and #1060 (https://github.com/stuarthopwood/refract/pull/1103)
- App-wide softer text via opacity (#1074) (https://github.com/stuarthopwood/refract/pull/1104)
- docs(plan): #1113 gate follow-ups (#1115, #1116) (https://github.com/stuarthopwood/refract/pull/1117)
- docs: place #1119-#1122 in the plan, amend #756's row (2026-10-21) (https://github.com/stuarthopwood/refract/pull/1123)
- docs: place #1124-#1127 in the plan (2026-10-21) (https://github.com/stuarthopwood/refract/pull/1128)
- docs: place #1129-#1132 and the #471 amendment in the plan (2026-10-21) (https://github.com/stuarthopwood/refract/pull/1133)
- docs: record the 2026-10-21 backlog triage and epics #1134-#1137 in the plan (https://github.com/stuarthopwood/refract/pull/1138)
- docs: record #1085 over #1098, dotted OMP keys (#691) and fold comments in the plan (https://github.com/stuarthopwood/refract/pull/1139)
- docs: place the OMP 18.12.5 review, #1140 and #1141 in the plan (https://github.com/stuarthopwood/refract/pull/1142)
- docs: close Phase R in the plan and qualify the Approve Once trap (https://github.com/stuarthopwood/refract/pull/1143)
- docs: place #1144 and #1145 in the plan (https://github.com/stuarthopwood/refract/pull/1146)
- docs: record the app-wide whitespace rule (#1144) in components.md and the plan (https://github.com/stuarthopwood/refract/pull/1147)
- docs: correct the whitespace rule: Button sm icon side is not yet compliant (#1144) (https://github.com/stuarthopwood/refract/pull/1148)
- docs: place #1149 and record the quiet placeholder contrast departure (https://github.com/stuarthopwood/refract/pull/1150)
- docs(plan): #1069 and #700 slice (b) done, file #1151 follow-ups (https://github.com/stuarthopwood/refract/pull/1152)

## v0.7.0 (2026-10-20)

### Features

- feat(#1050): composer command pill, spellcheck off for recognised commands (https://github.com/stuarthopwood/refract/pull/1064)
- feat(#700,#701): slice (a) pinned todo panel + pin-toggle readout (https://github.com/stuarthopwood/refract/pull/1054)
- feat(464): Git changes panel, slice 1 of 3 (changes list, stage/unstage, commit, auto-refresh) (https://github.com/stuarthopwood/refract/pull/1076)
- feat(1077): collapse Stage/subagent rows to goal + See input & output toggle (https://github.com/stuarthopwood/refract/pull/1095)
- feat(#1039): Cyber Amber retuned onto Default Dark's surfaces, vivid orange accent (https://github.com/stuarthopwood/refract/pull/1094)

### Other

- docs: PLAN.md row for #1067 Enter sends queued follow-up (https://github.com/stuarthopwood/refract/pull/1068)
- docs: PLAN.md row for #1069 Model roles overhaul (https://github.com/stuarthopwood/refract/pull/1071)
- docs: PLAN row for #1070 (Settings theme picker swatch chip) (https://github.com/stuarthopwood/refract/pull/1072)
- docs: PLAN rows for #1073 (Settings dividers) and #1074 (app-wide text opacity) (https://github.com/stuarthopwood/refract/pull/1075)
- docs: PLAN row for issue #1077 (agent rows show only the goal) (https://github.com/stuarthopwood/refract/pull/1078)
- docs(gate): risk-tiered review gate design (https://github.com/stuarthopwood/refract/pull/1079)
- docs(plan): place #1080 Tab indent, #1081 slash recents, #1082 context heatmap (https://github.com/stuarthopwood/refract/pull/1083)
- docs(plan): place #1085 finished subagent cleanup (https://github.com/stuarthopwood/refract/pull/1086)
- docs(plan): #766 combined Role·Model pill, Ctrl+R cycling, change any time (https://github.com/stuarthopwood/refract/pull/1088)
- docs(plan): place #1089 Prism (https://github.com/stuarthopwood/refract/pull/1090)
- docs(plan): #691 OMP settings in Settings (read live, curated rows) (https://github.com/stuarthopwood/refract/pull/1092)
- docs(gate): review gate contracts and core implementation plan (https://github.com/stuarthopwood/refract/pull/1096)
- docs: PLAN.md row for #1098 Agent list parked status (https://github.com/stuarthopwood/refract/pull/1099)

## v0.6.0 (2026-10-20)

### Features

- feat(#741): composer role chip, pin persistence, provider-friendly details card (https://github.com/stuarthopwood/refract/pull/1037)
- feat(#1048): Holiday touches -- framework + Halloween (https://github.com/stuarthopwood/refract/pull/1053)

### Fixes

- fix(#891): Delete handles full/long-path worktrees and holder preflight (https://github.com/stuarthopwood/refract/pull/1038)
- fix(#1043): Theme submenu is a real radio list on the shared DropdownMenuRadioItem (https://github.com/stuarthopwood/refract/pull/1057)

### Other

- docs(plan): place #1039 (Cyber Amber retune, softer text) and amend the chat text colour rule (https://github.com/stuarthopwood/refract/pull/1040)
- docs(plan): place #1041 Advisor source tag (https://github.com/stuarthopwood/refract/pull/1042)
- docs(plan): place #1043 Theme submenu radios; record the menu radio rule (https://github.com/stuarthopwood/refract/pull/1044)
- docs(plan): OMP 18.10.2-18.12.2 review; retarget #520 to 18.12.2 (https://github.com/stuarthopwood/refract/pull/1045)
- docs(plan): #476 Session cleanup grilled; glossary Delete and Session cleanup (https://github.com/stuarthopwood/refract/pull/1046)
- docs(plan): #456 amended, Markdown and syntax tokens take each theme's accent (https://github.com/stuarthopwood/refract/pull/1047)
- docs(plan): place #1048 Holiday touches, add the decorative-motion exception and glossary term (https://github.com/stuarthopwood/refract/pull/1049)
- docs(plan): place #1050 composer command pill (https://github.com/stuarthopwood/refract/pull/1051)
- docs(plan): place #1055 Delete dialog follow-ups (https://github.com/stuarthopwood/refract/pull/1056)
- docs: plan update for #1048 slice 1 and #1058 follow-ups (https://github.com/stuarthopwood/refract/pull/1059)
- docs(plan): #464 slice map, slice 1 in-flight, #1060/#1061 rows (https://github.com/stuarthopwood/refract/pull/1062)
- chore: move holiday IPC types out of ipc.ts to clear the file-size cap (https://github.com/stuarthopwood/refract/pull/1063)
- docs(plan): #1043 done, #1065 follow-ups placed (https://github.com/stuarthopwood/refract/pull/1066)

## v0.5.0 (2026-10-19)

### Features

- feat(chat): #1012 history dialog follow-ups (focus tooltip, focus ring, date truncate, verify-439) (https://github.com/stuarthopwood/refract/pull/1024)
- feat(#975): code-block background follows each theme's own --card, not the bundled Shiki theme (https://github.com/stuarthopwood/refract/pull/1032)

### Fixes

- fix(991): Stage row focus, toggle memory, selector scoping (https://github.com/stuarthopwood/refract/pull/999)
- fix(subagents): scope async-result job matching to unresolved Stage items (#989) [live-verified] (https://github.com/stuarthopwood/refract/pull/1003)
- fix(862): stream bounded Conversation preview scan past OMP's new prelude entries (https://github.com/stuarthopwood/refract/pull/1006)
- fix(439): Conversation history truncates with an ellipsis, no horizontal scroll (https://github.com/stuarthopwood/refract/pull/1011)
- fix(1000): Stage rows defer running auto-open to the chain row once a turn has two or more Stages (https://github.com/stuarthopwood/refract/pull/1007)
- fix(911): Stop-cut-short tool rows settle to a neutral cancelled status (https://github.com/stuarthopwood/refract/pull/1015)
- fix(a11y): preserve focus when a solo Stage gains a second agent (https://github.com/stuarthopwood/refract/pull/1027)
- fix(chat): notice severity tokens, non-dismissing unknown-command warning toast (https://github.com/stuarthopwood/refract/pull/1031)

### Other

- Slash refusal text, notice wrap, advisor settings mention (#938 items 2, 3, 5) (https://github.com/stuarthopwood/refract/pull/996)
- docs(plan): add #1004 follow-ups from #991/#938 gates (https://github.com/stuarthopwood/refract/pull/1005)
- docs(plan): add #1008 follow-up from #1007/#1000 ui gate (https://github.com/stuarthopwood/refract/pull/1009)
- docs(plan): confirm #439 history-dialog truncation fix, record decision (https://github.com/stuarthopwood/refract/pull/1010)
- docs: place #1012 follow-ups row in PLAN.md (https://github.com/stuarthopwood/refract/pull/1013)
- docs: PLAN.md row for #1016 (#802 scrollbar follow-ups) (https://github.com/stuarthopwood/refract/pull/1017)
- docs: PLAN.md row for #1018 (#911 gate follow-ups, PR #1015) (https://github.com/stuarthopwood/refract/pull/1019)
- docs(plan): add #1021 and #1022 rows (https://github.com/stuarthopwood/refract/pull/1023)
- UI polish: Stage rows - failed Stage label colour and jump to Stage from the chain row (#1008) (https://github.com/stuarthopwood/refract/pull/1020)
- docs(plan): add #1025 row, mark #1008 done (https://github.com/stuarthopwood/refract/pull/1026)
- chore(scripts): #1022 verify-563 targets selectable tree rows (https://github.com/stuarthopwood/refract/pull/1028)
- docs(plan): add #1029 row (#1001 gate follow-ups) (https://github.com/stuarthopwood/refract/pull/1030)

## v0.4.0 (2026-10-18)

### Features

- feat(chat): #917 allow /advisor (on, off, status) per Session (https://github.com/stuarthopwood/refract/pull/923)
- feat(r559): session list search field (#559) (https://github.com/stuarthopwood/refract/pull/939)
- feat(r560): quiet alert rows -- low memory opens a triage list, unverified omp version opens Health check (https://github.com/stuarthopwood/refract/pull/945)
- feat(554): Settings chat reading width (Full default, Reading column 64rem) (https://github.com/stuarthopwood/refract/pull/966)
- Feat: fuzzy slash-command search, subcommand step, command-reply turn time (#947, #938) (https://github.com/stuarthopwood/refract/pull/954)
- feat(925,924): diff-stat colour and reasoning gauge needle (https://github.com/stuarthopwood/refract/pull/967)
- Feat(#551): Nordic Frost and Cyber Amber dark presets; #552 HC decision + partial fix (red at 7:1) (https://github.com/stuarthopwood/refract/pull/973)
- feat(937): advisor chip in the composer status line (https://github.com/stuarthopwood/refract/pull/972)
- Feat: attach any file type, inlining text up to 256 KB (#926) (https://github.com/stuarthopwood/refract/pull/976)
- feat(941): Stage naming, green finished state, real dependencies (part 1 of 2) (https://github.com/stuarthopwood/refract/pull/979)
- feat(chat): centre and enlarge the Session start notice for every Session (https://github.com/stuarthopwood/refract/pull/978)
- feat(941): Subagent panel Stage grouping, green state, Up next (part 2 of 2) (https://github.com/stuarthopwood/refract/pull/993)

### Fixes

- fix(#556): zero-box sweep for NoticeRow and ChatPane detail disclosures (https://github.com/stuarthopwood/refract/pull/944)
- fix(renderer): annotate cn's type so typecheck passes on main (https://github.com/stuarthopwood/refract/pull/961)
- fix(chat): collapsed tool group Error line prefix runs into the message (https://github.com/stuarthopwood/refract/pull/963)
- fix(chat): toasts no longer cover the Send button (#980) (https://github.com/stuarthopwood/refract/pull/982)
- fix(shell): set the window icon and AppUserModelID so the taskbar shows the Refract logo (#880) (https://github.com/stuarthopwood/refract/pull/987)
- fix(session): include startProgress in sessions.list() summary rows (https://github.com/stuarthopwood/refract/pull/988)

### Other

- docs(plan): v0.3.0 feedback #924-#928, Composer tone rule replaced (#927) (https://github.com/stuarthopwood/refract/pull/929)
- docs(plan): Pull requests list feedback, #499 amended and #930 filed (https://github.com/stuarthopwood/refract/pull/931)
- docs(plan): place #932 Ask card notes (https://github.com/stuarthopwood/refract/pull/933)
- docs: reusable UI components rule, ADR 0003; place #934 and #935 (https://github.com/stuarthopwood/refract/pull/936)
- Profile menu update entry + sidebar Pull requests active count (#569) (https://github.com/stuarthopwood/refract/pull/920)
- docs: place #941 Stage polish; glossary and status-colour amendment (https://github.com/stuarthopwood/refract/pull/942)
- Chat: show the time above the user message, mark turn boundaries clearly (#555) (https://github.com/stuarthopwood/refract/pull/940)
- docs(plan): place late 2026-10-16 issues (#937, #938, #943, #946, #947) (https://github.com/stuarthopwood/refract/pull/948)
- Chore: require shared CARGO_TARGET_DIR in live-check scripts and ci-local (https://github.com/stuarthopwood/refract/pull/949)
- docs(plan): place #952 zero-box gate follow-ups (https://github.com/stuarthopwood/refract/pull/955)
- docs(plan): place #956 alert rows follow-ups (https://github.com/stuarthopwood/refract/pull/957)
- Quiet composer (#927) and status line type (#928) (https://github.com/stuarthopwood/refract/pull/951)
- docs(plan): place #959 quiet composer follow-ups (https://github.com/stuarthopwood/refract/pull/960)
- Chat: borderless thread for grouped tool calls and command-style rows (#632) (https://github.com/stuarthopwood/refract/pull/950)
- docs(plan): add #964 error-prefix follow-ups row (https://github.com/stuarthopwood/refract/pull/965)
- Pull requests: filter redesign (#499) and resizable list column (#930) (https://github.com/stuarthopwood/refract/pull/953)
- docs: file #980 toast-covers-Send bug in PLAN.md (https://github.com/stuarthopwood/refract/pull/981)
- docs(plan): place #983 toast and quick-create follow-ups (https://github.com/stuarthopwood/refract/pull/984)
- docs(plan): place #985 start prompt investigation (https://github.com/stuarthopwood/refract/pull/986)
- docs(plan): place #989 async-result Stage row (https://github.com/stuarthopwood/refract/pull/990)
- docs(plan): place #991 Stage row focus and toggle follow-ups (https://github.com/stuarthopwood/refract/pull/992)
- docs(plan): file #994 verify-672 script follow-ups (https://github.com/stuarthopwood/refract/pull/995)
- docs: add #997 notices/refusal toasts follow-ups to PLAN.md (https://github.com/stuarthopwood/refract/pull/998)

## v0.3.0 (2026-10-16)

### Features

- feat(chat): composer restyle with status line and in-box pickers (#564) (https://github.com/stuarthopwood/refract/pull/877)
- feat(chat): #572 Ask card restyle - tab row, tick boxes, structured dialog (https://github.com/stuarthopwood/refract/pull/900)
- feat(sessions): Unread response status icon, new idle icon (#731) (https://github.com/stuarthopwood/refract/pull/902)
- feat(chat,subagents): subagent stages, chain row and tree panel (#563) (https://github.com/stuarthopwood/refract/pull/899)
- feat(chat): connected-log spine (guide rails) -- CollapsedLine geometry, ToolGroupRow on SpineList (https://github.com/stuarthopwood/refract/pull/906)
- feat(chat): #570 tool row colour treatment -- neutral success, error icon/label/line, group meta counts (https://github.com/stuarthopwood/refract/pull/909)
- feat(chat): #557 collapse consecutive thoughts into one Thought process row (https://github.com/stuarthopwood/refract/pull/912)
- feat(chat): #558 blocker callout -- accent bar, locations, Copy, Ask agent to address this (https://github.com/stuarthopwood/refract/pull/916)

### Other

- docs(plan): place installer and updater feedback issues (https://github.com/stuarthopwood/refract/pull/884)
- docs(plan): place the temp-folder leak issue (https://github.com/stuarthopwood/refract/pull/886)
- docs(plan): place #887 Project colour; amend decorative-colour rule (https://github.com/stuarthopwood/refract/pull/888)
- docs(design): allow a user-chosen Project colour in the colour rule (#887) (https://github.com/stuarthopwood/refract/pull/889)
- docs(plan): place #891 Delete Session dead-end bug (A9) (https://github.com/stuarthopwood/refract/pull/892)
- docs(plan): #891 git metadata contract (no repo-wide prune) (https://github.com/stuarthopwood/refract/pull/893)
- docs(plan): place #877 review follow-ups (https://github.com/stuarthopwood/refract/pull/898)
- refactor(sessions): split SessionList.tsx along its group/row seams (#811) (https://github.com/stuarthopwood/refract/pull/901)
- UI polish: Session list collapse/expand toolbar + persisted state (#735) (https://github.com/stuarthopwood/refract/pull/905)
- Session list restyle: rows, group headers and footer, to the mock (#567) (https://github.com/stuarthopwood/refract/pull/910)
- Pull requests: restyle list rows, header, tabs and the detail layout to the mock (#568) (https://github.com/stuarthopwood/refract/pull/914)
- docs: remove scratch copies of PLAN.md (https://github.com/stuarthopwood/refract/pull/922)

## v0.2.0 (2026-10-15)

### Features

- feat: brand watermark (spec 012) (https://github.com/stuarthopwood/refract/pull/462)
- feat: brand spinner (spec 011) (https://github.com/stuarthopwood/refract/pull/461)
- feat: profile and accounts (spec 008) (https://github.com/stuarthopwood/refract/pull/451)
- feat(session-list): add repository after first-run (#447) (https://github.com/stuarthopwood/refract/pull/486)
- feat(session-list): remove a repository, blocked while it owns Sessions (#488) (https://github.com/stuarthopwood/refract/pull/493)
- feat(#480): persisted repository display-name rename (https://github.com/stuarthopwood/refract/pull/586)
- feat(#509): Resume button on Sessions terminated unexpectedly (https://github.com/stuarthopwood/refract/pull/585)
- feat(chat): Copy button on every code surface (#524) (https://github.com/stuarthopwood/refract/pull/597)
- Feat: animated agent-working spinner replaces the brand spinner (#612) (https://github.com/stuarthopwood/refract/pull/616)
- feat(#457): wire thinking/tool-call Settings toggles into the chat transcript (https://github.com/stuarthopwood/refract/pull/595)
- feat(#610): hyperlinks for web URLs and worktree file paths in chat (https://github.com/stuarthopwood/refract/pull/642)
- feat(#6): Ctrl+N creates a new Session (first slice) (https://github.com/stuarthopwood/refract/pull/647)
- feat(tauri): land the Rust (Tauri v2) build on main, milestone 1 (#780, part of R1 #784) (https://github.com/stuarthopwood/refract/pull/805)
- feat(r5): readout, subagents and memory warning in Rust (https://github.com/stuarthopwood/refract/pull/845)
- feat(tauri): name the app Refract and use the logo as the installer icon (https://github.com/stuarthopwood/refract/pull/855)
- feat(release): one-command pnpm release with version bump, changelog and local CI (https://github.com/stuarthopwood/refract/pull/853)

### Fixes

- fix(chat): ask question card renders sanitised markdown, vertical wrapping options (#491, #497) (https://github.com/stuarthopwood/refract/pull/534)
- fix(reattach): a lower message count re-baselines; start-failed banner gets recovery actions (#449) (https://github.com/stuarthopwood/refract/pull/535)
- fix(subagents): wrap long content and fix padding in the Agents panel (#492) (https://github.com/stuarthopwood/refract/pull/542)
- fix(chat): switching Sessions lands at the end and restores a detached position (#485) (https://github.com/stuarthopwood/refract/pull/574)
- fix(subagents): restore the Subagents pill after a crash and resume, durable turn marker (#489, #536) (https://github.com/stuarthopwood/refract/pull/575)
- fix(chat): reset Context/Todo/Subagents chips after New conversation (#577) (https://github.com/stuarthopwood/refract/pull/592)
- fix(chat): atomic queued-message send-now and remove (#540) (https://github.com/stuarthopwood/refract/pull/591)
- fix(main): taskbar/notification icon shows Refract logo, not Electron atom (#494) (https://github.com/stuarthopwood/refract/pull/590)
- fix(indent): restore 2-space indentation in 4 files damaged by the write-tool bug (#387) (https://github.com/stuarthopwood/refract/pull/589)
- fix(#510): detect unexpected termination from the Conversation tail (slices 1-3) (https://github.com/stuarthopwood/refract/pull/584)
- fix(chat): replace optimistic reservations in queued chips (#540 follow-up) (https://github.com/stuarthopwood/refract/pull/598)
- fix(omp): replace fixed 60s ready-frame kill with staged wait + log tail (#512) (https://github.com/stuarthopwood/refract/pull/581)
- fix(pr-view): repository selector drag-region dead-click and merge dialog overflow (#500, #498) (https://github.com/stuarthopwood/refract/pull/583)
- fix(main): use a distinct AppUserModelId for dev launches (#494) (https://github.com/stuarthopwood/refract/pull/615)
- fix(#603): Resume (#509) follow-ups from the final #585 review (https://github.com/stuarthopwood/refract/pull/626)
- fix(#599): Delete Session fails with "is not a working tree" and cannot be retried (https://github.com/stuarthopwood/refract/pull/627)
- fix: flush install writes, cap release-view error, stream omp script body (follow-up #794) (https://github.com/stuarthopwood/refract/pull/832)
- fix(r13a): never import real Electron data into an overridden data dir (https://github.com/stuarthopwood/refract/pull/854)
- fix(r3): wire TranscriptState::set_terminated_unexpectedly from crash-tail detection (https://github.com/stuarthopwood/refract/pull/851)
- fix(rm): unify /role and /switch @<role> validation, fix colon-id and sweep-retry edge cases (https://github.com/stuarthopwood/refract/pull/852)
- fix(rm): sweep re-read race, alias-hop resolution, logging scope (https://github.com/stuarthopwood/refract/pull/857)
- fix(r5): reattach notice dead-code gap + stream-eviction dedupe churn (https://github.com/stuarthopwood/refract/pull/858)
- fix(tauri): stop blocking frame delivery on the settle-time get_state (#856) (https://github.com/stuarthopwood/refract/pull/859)
- fix(rust): let scratch debug instances run beside a live Refract (https://github.com/stuarthopwood/refract/pull/864)

### Other

- spec 007: app themes (presets, live preview, Mermaid/syntax theming) (https://github.com/stuarthopwood/refract/pull/390)
- Brand: new app icon and SVG hero (https://github.com/stuarthopwood/refract/pull/396)
- Spec 011: Brand spinner (https://github.com/stuarthopwood/refract/pull/407)
- Spec 012: Brand watermark (https://github.com/stuarthopwood/refract/pull/426)
- spec 003: pull request management (browse, review, merge, start a session from a PR) (https://github.com/stuarthopwood/refract/pull/389)
- docs: add PLAN.md work queue and agent pointers (https://github.com/stuarthopwood/refract/pull/481)
- docs(plan): confirm the story and approach with Stuart before starting (https://github.com/stuarthopwood/refract/pull/484)
- docs(spec-001): spec and plan for removing a repository (https://github.com/stuarthopwood/refract/pull/487)
- docs: plan update - FDB panels (p1), session status style, probes (https://github.com/stuarthopwood/refract/pull/483)
- Bump actions/setup-node from 4.4.0 to 7.0.0 (https://github.com/stuarthopwood/refract/pull/95)
- Bump actions/checkout from 4.4.0 to 7.0.1 (https://github.com/stuarthopwood/refract/pull/96)
- docs: plan update - #494 icon bug, A1 and A5 done (https://github.com/stuarthopwood/refract/pull/495)
- docs: plan update - #497 to #500 (https://github.com/stuarthopwood/refract/pull/501)
- docs: plan update - #502 to #507 (https://github.com/stuarthopwood/refract/pull/508)
- docs: plan update - #510 P1 at the top (A0) (https://github.com/stuarthopwood/refract/pull/511)
- docs: plan update - #515 to #529 (https://github.com/stuarthopwood/refract/pull/530)
- docs: plan update - #536 Subagents pill (https://github.com/stuarthopwood/refract/pull/537)
- docs: plan update - #538 right pane rules (https://github.com/stuarthopwood/refract/pull/539)
- docs: plan update - #540 queued messages (https://github.com/stuarthopwood/refract/pull/541)
- docs: plan update - #543 skill rows (https://github.com/stuarthopwood/refract/pull/544)
- docs: plan update - #545 log rendering audit (https://github.com/stuarthopwood/refract/pull/546)
- docs: plan update - #547 skill-prompt, #545 provenance (https://github.com/stuarthopwood/refract/pull/548)
- docs: plan update - UI refresh epic #549 (#550 to #561) (https://github.com/stuarthopwood/refract/pull/562)
- docs: plan update - mockup review gaps #563 to #572 (https://github.com/stuarthopwood/refract/pull/573)
- docs: plan update - #563, #564, #572 raised to p1 (https://github.com/stuarthopwood/refract/pull/576)
- docs: plan update - #577 chips reset on New conversation (https://github.com/stuarthopwood/refract/pull/578)
- docs(plan): settle Phase A merged-PR rows, dedupe A2b/A2c, verify spec 003/008/011/012 task issues (https://github.com/stuarthopwood/refract/pull/587)
- docs(plan): add A7 (#599) Delete Session worktree dead end (https://github.com/stuarthopwood/refract/pull/600)
- docs(plan): #601 setup screen polish, tighten A7 orphan predicate (https://github.com/stuarthopwood/refract/pull/602)
- docs(plan): place #603 Resume follow-ups as row A2i (https://github.com/stuarthopwood/refract/pull/604)
- #550 Theme foundation: palette v2, surface ladder, divider vs control-edge classes (https://github.com/stuarthopwood/refract/pull/596)
- Add repo rule: no new tests while rapid prototyping (https://github.com/stuarthopwood/refract/pull/605)
- Settings: Model roles section backed by omp config (#455) (https://github.com/stuarthopwood/refract/pull/594)
- Soften panel dividers; remove header bottom borders (https://github.com/stuarthopwood/refract/pull/606)
- docs(spike): partial probe results on omp 18.8.0 (#520, B2) (https://github.com/stuarthopwood/refract/pull/582)
- docs(design): UI design system from the #474 grill (https://github.com/stuarthopwood/refract/pull/580)
- docs(spec): right pane shell (#538, #393, #394) — spec, plan, tasks (https://github.com/stuarthopwood/refract/pull/588)
- docs(design): header shades replace divider lines; docs-PR merge rule (https://github.com/stuarthopwood/refract/pull/607)
- docs(plan): reconcile statuses after the 2026-10-08/09 merge run (https://github.com/stuarthopwood/refract/pull/608)
- docs: focus ring stays achromatic (decided); drop stale plan SHA (https://github.com/stuarthopwood/refract/pull/609)
- docs: place #610 (chat hyperlinks) in the plan (https://github.com/stuarthopwood/refract/pull/611)
- docs: place #612 (agent-working spinner, supersedes spec 011) in the plan (https://github.com/stuarthopwood/refract/pull/613)
- docs(plan): record live verification of #510/#509, re-open A6 taskbar icon (https://github.com/stuarthopwood/refract/pull/614)
- docs(plan): #618 session start polish (https://github.com/stuarthopwood/refract/pull/619)
- docs: place #620 and #621 in the plan (https://github.com/stuarthopwood/refract/pull/622)
- docs(plan): A6 (#494 taskbar icon) in-flight -> done, live-verified (https://github.com/stuarthopwood/refract/pull/617)
- docs(plan): #623 window state lane (https://github.com/stuarthopwood/refract/pull/624)
- docs(plan): record app updates request (spec 006 US3) (https://github.com/stuarthopwood/refract/pull/625)
- docs(plan): #628 tool call rows, correct app updates wording (https://github.com/stuarthopwood/refract/pull/629)
- docs(plan): #630 edit call rows (https://github.com/stuarthopwood/refract/pull/631)
- docs(plan): #632 grouped and command-style call rows (https://github.com/stuarthopwood/refract/pull/633)
- Close a Session's chat pane (#621) (https://github.com/stuarthopwood/refract/pull/634)
- Follow-up: Ctrl+W/modal-guard polish from #634 gate (#621) (https://github.com/stuarthopwood/refract/pull/636)
- docs(plan): #638 repository order (https://github.com/stuarthopwood/refract/pull/639)
- Ctrl+, opens Settings; trim keyboard table to reality (#395, #429) (https://github.com/stuarthopwood/refract/pull/637)
- Add "New session from {branch}" to the Session row's item menu (#620) (https://github.com/stuarthopwood/refract/pull/635)
- Fix comment accuracy: Turkish-Q W/comma key claims (gate follow-up) (https://github.com/stuarthopwood/refract/pull/640)
- Remove the Setup/readiness screen's grey box (#601) (https://github.com/stuarthopwood/refract/pull/641)
- UI polish: one cross-repository Archived group styled like a repository header (#527) (https://github.com/stuarthopwood/refract/pull/643)
- Composer: empty-state hint overlay for Markdown and slash commands (#533) (https://github.com/stuarthopwood/refract/pull/644)
- UI polish: icons on session list group headers (#528) (https://github.com/stuarthopwood/refract/pull/645)
- Session start: unboxed starting message, random pool, real history signal (#618) (https://github.com/stuarthopwood/refract/pull/649)
- Docs: icon rule (Tabler when lucide lacks the icon) and closed shortcut issues (https://github.com/stuarthopwood/refract/pull/651)
- Docs: plan refresh 2026-10-10 (https://github.com/stuarthopwood/refract/pull/652)
- docs(plan): #638 reorder returns the canonical list (https://github.com/stuarthopwood/refract/pull/653)
- Chat: tool-call dialogs (#628) + capped edit diff (#630) (https://github.com/stuarthopwood/refract/pull/654)
- docs(plan): worktree hygiene lanes (#658, #657, #656) (https://github.com/stuarthopwood/refract/pull/659)
- Right pane shell: foundation + Subagents panel hosted (spec 013 slice 1 of 4) (https://github.com/stuarthopwood/refract/pull/655)
- docs(plan): portable workflow and Session notes (#658 amended, #660) (https://github.com/stuarthopwood/refract/pull/661)
- docs(plan): #660 is p1, scope limited to Refract facts (https://github.com/stuarthopwood/refract/pull/662)
- Right pane shell: FDB Knowledge/Agent Builder placeholders, tab-bar restructure (spec 013 slice 2 of 4) (https://github.com/stuarthopwood/refract/pull/663)
- Right pane shell: Settings switch + sample content (spec 013 slice 3 of 4, PR3 of 4) (https://github.com/stuarthopwood/refract/pull/664)
- Right pane shell: non-drag width-preset control + final live verification (spec 013 slice 4, PR4 of 4) (https://github.com/stuarthopwood/refract/pull/665)
- docs/PLAN.md: C1 row reflects PR1-PR4 merged (#538 right pane shell) (https://github.com/stuarthopwood/refract/pull/666)
- Side chat (/btw): spec 014 + constitution amendment (docs only) (https://github.com/stuarthopwood/refract/pull/667)
- Slice 1+2: side chat hosted + native btw RPC wiring (https://github.com/stuarthopwood/refract/pull/668)
- Side chat (/btw): Slice 3 polish -- Copy action, Clear thread, full gate + live verification (https://github.com/stuarthopwood/refract/pull/669)
- Spec 015: file explorer (issue #463) -- Spec Kit docs only (https://github.com/stuarthopwood/refract/pull/670)
- docs(plan): #672 session start message centred and larger (p1) (https://github.com/stuarthopwood/refract/pull/673)
- docs(plan): #674 right pane resize and surface, #675 side chat composer (https://github.com/stuarthopwood/refract/pull/676)
- docs(plan): #674 width control required, #675 Send and Clear thread (https://github.com/stuarthopwood/refract/pull/677)
- docs(plan): #678 switching animations (https://github.com/stuarthopwood/refract/pull/679)
- docs(plan): #680 close chat pane icon (https://github.com/stuarthopwood/refract/pull/681)
- docs(plan): #682 title bar surface (https://github.com/stuarthopwood/refract/pull/683)
- docs(plan): #684 split focus cue, #682 top-layer bar (https://github.com/stuarthopwood/refract/pull/685)
- docs(plan): #686 ghost button, #687 current work banner (https://github.com/stuarthopwood/refract/pull/688)
- docs(plan): #689 OMP release review process (https://github.com/stuarthopwood/refract/pull/690)
- docs(plan): OMP feature batch (#691 to #698) (https://github.com/stuarthopwood/refract/pull/699)
- docs(plan): #700, #701, #702, fix #687 row (https://github.com/stuarthopwood/refract/pull/703)
- docs(plan): agent reactions found (#704) (https://github.com/stuarthopwood/refract/pull/705)
- docs(plan): #706 XState spike result (https://github.com/stuarthopwood/refract/pull/707)
- docs(plan): correct @xstate/store speed figure (#706) (https://github.com/stuarthopwood/refract/pull/708)
- docs(plan): add #709 SessionAgent split (https://github.com/stuarthopwood/refract/pull/710)
- docs(plan): scope the #709 size claim (https://github.com/stuarthopwood/refract/pull/711)
- docs(plan): add #712 and the Agents panel refinements (https://github.com/stuarthopwood/refract/pull/713)
- docs(plan): add #714 Settings polish (https://github.com/stuarthopwood/refract/pull/715)
- docs(plan): probe-gate the #714 inherited-model display (https://github.com/stuarthopwood/refract/pull/716)
- docs(plan): add #717 Settings icons (https://github.com/stuarthopwood/refract/pull/718)
- docs(plan): add #719 tool call markdown (https://github.com/stuarthopwood/refract/pull/720)
- docs(plan): #628 row, #719 is proposed not shipped (https://github.com/stuarthopwood/refract/pull/721)
- File explorer (spec 015, #463) -- Slices 1-3, gate rounds 4-19 (two keyboard-focus defects open, disclosed) (https://github.com/stuarthopwood/refract/pull/671)
- Spec 009 amendment: path-based image attach (#514) + drag-and-drop (#432) -- docs only (https://github.com/stuarthopwood/refract/pull/722)
- docs(plan): add #724 current branch in the composer strip (https://github.com/stuarthopwood/refract/pull/725)
- docs(plan): #724 resolve HEAD path with git rev-parse (https://github.com/stuarthopwood/refract/pull/726)
- docs(plan): add #729, #730, #731, #732 (https://github.com/stuarthopwood/refract/pull/733)
- docs(plan): #730 no dead Git changes rail button (https://github.com/stuarthopwood/refract/pull/734)
- docs(plan): add #735 Session list collapse (https://github.com/stuarthopwood/refract/pull/736)
- docs(plan): #735 aria-disabled no-op buttons (https://github.com/stuarthopwood/refract/pull/737)
- docs(plan): add #738 pane resize handles (https://github.com/stuarthopwood/refract/pull/739)
- docs(plan): add P0 model and role row (#454, #740, #741) (https://github.com/stuarthopwood/refract/pull/742)
- docs(plan): #740 start-time roles are probe-gated (https://github.com/stuarthopwood/refract/pull/743)
- docs(plan): add #744 attachment-only send (https://github.com/stuarthopwood/refract/pull/745)
- docs(plan): add #746 pane error banner redesign (https://github.com/stuarthopwood/refract/pull/747)
- docs(plan): add #748 hide Sessions (https://github.com/stuarthopwood/refract/pull/749)
- docs(plan): add the chat navigation lane (#750 to #754) (https://github.com/stuarthopwood/refract/pull/755)
- docs(plan): add #756 Explorer row actions (https://github.com/stuarthopwood/refract/pull/757)
- docs(plan): add #758 virtual target links bug (https://github.com/stuarthopwood/refract/pull/759)
- docs(plan): add #760 custom commands and skills (https://github.com/stuarthopwood/refract/pull/761)
- docs(plan): add #762 /switch command (https://github.com/stuarthopwood/refract/pull/763)
- docs(plan): #762 /model is an alias of /switch (https://github.com/stuarthopwood/refract/pull/764)
- docs(plan): #762 /models opens the Model roles settings (https://github.com/stuarthopwood/refract/pull/765)
- docs(plan): add #766 role switcher (https://github.com/stuarthopwood/refract/pull/767)
- docs(plan): add #768 and #769 (https://github.com/stuarthopwood/refract/pull/770)
- docs(plan): add B8 OMP worker memory probes (#772, #773) (https://github.com/stuarthopwood/refract/pull/774)
- Composer: path-based image attach (#514) + drag-and-drop (#432) (https://github.com/stuarthopwood/refract/pull/723)
- docs(plan): add streaming performance lane (#776-#779) and Rust build experiment (#780) (https://github.com/stuarthopwood/refract/pull/781)
- docs: PLAN status after C4 and composer images merges (https://github.com/stuarthopwood/refract/pull/775)
- chat: skill rows (#543 first slice) + skill-prompt row (#547) (https://github.com/stuarthopwood/refract/pull/782)
- docs(plan): Rust promotion plan of attack (epic #797) (https://github.com/stuarthopwood/refract/pull/798)
- docs(plan): rust-tauri uncommitted edits are not an R1 task (https://github.com/stuarthopwood/refract/pull/799)
- docs(plan): add #800 icon rail size (https://github.com/stuarthopwood/refract/pull/801)
- docs(plan): add #802 double scrollbar bug (https://github.com/stuarthopwood/refract/pull/803)
- docs(plan): #802 candidate framing (https://github.com/stuarthopwood/refract/pull/804)
- docs(plan): god-file ratchet and splits (#806 to #814) (https://github.com/stuarthopwood/refract/pull/815)
- RM0: OMP model/role family probes over rpc-ui (https://github.com/stuarthopwood/refract/pull/817)
- R10a: shell spikes (window drag, file drop, clipboard paste, notification click, WebView2 audit) (https://github.com/stuarthopwood/refract/pull/818)
- R11a: installer and update probes (#794) (https://github.com/stuarthopwood/refract/pull/819)
- R1: Tauri is the default build, Windows CI, check:parity and per-lane Rust modules (#784) (https://github.com/stuarthopwood/refract/pull/816)
- R12a: CDP harness + recorded-frame fake omp for the Tauri build (https://github.com/stuarthopwood/refract/pull/820)
- R4: chat send path, attachments, image caps and slash-command source policy (https://github.com/stuarthopwood/refract/pull/821)
- R10b: window shell, notifications, single instance, window state, security baseline (#793) (https://github.com/stuarthopwood/refract/pull/823)
- R2: session worktree and lifecycle parity (archive, restore, delete, recreate, diffStat, reveal, remotes, rename) (https://github.com/stuarthopwood/refract/pull/826)
- R8: Settings setters, theme, model roles, generic omp config, native menu (https://github.com/stuarthopwood/refract/pull/822)
- R9: GitHub parity -- pull requests, accounts, OMP sign-in, release notes (#792) (https://github.com/stuarthopwood/refract/pull/824)
- R7: File Explorer and file-security parity (https://github.com/stuarthopwood/refract/pull/828)
- docs: update Phase R status rows (https://github.com/stuarthopwood/refract/pull/830)
- docs: R13 trigger decision and R13a split (#796) (https://github.com/stuarthopwood/refract/pull/831)
- R11b: installer, dependency install and updates on Tauri (#794) (https://github.com/stuarthopwood/refract/pull/829)
- docs(plan): add #838 and #839 (https://github.com/stuarthopwood/refract/pull/840)
- docs(plan): #838 A2A steering in the same style (https://github.com/stuarthopwood/refract/pull/841)
- R13a: one-time Electron-to-Rust data import (#796 acceptance item 6) (https://github.com/stuarthopwood/refract/pull/833)
- updates: sign the installer locally and pin the signer cert (refs #794) (https://github.com/stuarthopwood/refract/pull/837)
- R3: agent start, recovery and resume as a typed state machine (https://github.com/stuarthopwood/refract/pull/827)
- R12b: transcript golden tests, contract replay, schema drift check, performance proof (https://github.com/stuarthopwood/refract/pull/834)
- docs(plan): add #842 and #843, settle #839 (https://github.com/stuarthopwood/refract/pull/844)
- RM: the P0 model and role family in Rust (set_model, cycle_model, roles, switch/role commands, plan gap) (https://github.com/stuarthopwood/refract/pull/836)
- docs(plan): add #846 idle agent stop (https://github.com/stuarthopwood/refract/pull/847)
- docs(plan): add #848 side chat handoff (https://github.com/stuarthopwood/refract/pull/849)
- docs(plan): refresh Phase R statuses from merged PRs (2026-10-14) (https://github.com/stuarthopwood/refract/pull/850)
- Rust R6: side chat (/btw) and word prediction, with the off switch (#772) (https://github.com/stuarthopwood/refract/pull/860)
- docs: update PLAN.md for PRs merged 2026-10-14 (https://github.com/stuarthopwood/refract/pull/861)
- docs: add #862 conversation list bug to PLAN.md (https://github.com/stuarthopwood/refract/pull/863)
- docs: record mockup stories review in PLAN.md (https://github.com/stuarthopwood/refract/pull/866)
- docs(plan): place #867 Add project flyout and clone (https://github.com/stuarthopwood/refract/pull/868)
- docs(plan): place #869 Home pane (https://github.com/stuarthopwood/refract/pull/870)
- chore(process): start every story with /grill-with-docs, then the full Spec Kit plan (https://github.com/stuarthopwood/refract/pull/871)
- docs: grill #867 and #869; CONTEXT.md Project, GitHub repository, Home (https://github.com/stuarthopwood/refract/pull/872)
- docs: grill #504 Issues view; place #874 (https://github.com/stuarthopwood/refract/pull/875)
- chore: delete the Electron build (R13, #796) (https://github.com/stuarthopwood/refract/pull/873)
- docs(plan): place #878 Markdown editor; glossary Rendered and Source view (https://github.com/stuarthopwood/refract/pull/879)
