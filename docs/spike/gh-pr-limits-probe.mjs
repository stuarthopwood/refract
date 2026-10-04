// GitHub API rate-limit budget probe (research.md "Polling interval and rate-limit headroom";
// tasks.md T004, issue #185).
//
// Question: what does `gh api rate_limit` actually report for this account's REST (`core`) and
// GraphQL budgets, and does spec 003's 15 s detail-view polling interval stay a small fraction of
// that budget?
//
// FORBIDDEN, no exceptions (user-confirmed safety steer, 2026-10-04): this script never attempts
// to provoke a real 403/429 rate-limited response. There is no safe way to do that on a real,
// shared GitHub account -- it would either burn a slice of the account's real quota (while the
// same account's other tools, including a live Refract instance, may be polling GitHub for their
// own reasons) or trip a secondary-abuse rate limit that can affect the account's GitHub access
// more broadly. The exact 403/429 error text and `gh`'s exit code are instead sourced, with
// citations, from `gh`'s own open-source error-handling code and GitHub's published REST docs --
// see the citations recorded alongside this script's output in docs/spike/FINDINGS.md row 4.
//
// The one live call this script makes (`gh api rate_limit`) is a single read of the account's
// current quota counters. It does not consume any budget beyond that one request.
//
// Run:  node docs/spike/gh-pr-limits-probe.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.join(os.tmpdir(), "pinion-gh-pr-limits-probe", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(ROOT, { recursive: true });

const POLL_INTERVAL_S = 15;
const POLLS_PER_HOUR = 3600 / POLL_INTERVAL_S;

const out = execFileSync("gh", ["api", "rate_limit"], { encoding: "utf8", timeout: 30_000 });
fs.writeFileSync(path.join(ROOT, "rate_limit.json"), out);
const data = JSON.parse(out);

const core = data.resources.core;
const graphql = data.resources.graphql;
const search = data.resources.search;

const results = {
  scratch: ROOT,
  observedAt: new Date().toISOString(),
  core: { limit: core.limit, used: core.used, remaining: core.remaining, resetUnix: core.reset },
  graphql: { limit: graphql.limit, used: graphql.used, remaining: graphql.remaining, resetUnix: graphql.reset },
  search: { limit: search.limit, used: search.used, remaining: search.remaining, resetUnix: search.reset },
  resourceKeys: Object.keys(data.resources),
  pollingHeadroom: {
    pollIntervalSeconds: POLL_INTERVAL_S,
    pollsPerHourIfOneDetailViewOpenContinuously: POLLS_PER_HOUR,
    coreLimitPerHour: core.limit,
    fractionOfCoreBudgetPerOpenDetailView: POLLS_PER_HOUR / core.limit,
  },
  rateLimitedErrorText: {
    source: "not reproduced live (forbidden, see header comment); sourced from gh/go-gh's own "
      + "error-handling code and GitHub's published REST docs instead",
    ghHttpErrorFormat: "HTTP %d: %s (%s)  -- cli/go-gh pkg/api/errors.go HTTPError.Error(), "
      + "https://github.com/cli/go-gh/blob/trunk/pkg/api/errors.go (the %s in the middle is "
      + "GitHub's own JSON response 'message' field, passed through verbatim)",
    githubPrimaryRateLimitMessageExample: "API rate limit exceeded for <user-or-app>. (But here's "
      + "the good news: Authenticated requests get a higher rate limit...)  -- GitHub REST API "
      + "docs, https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api",
    githubSecondaryRateLimitMessageExample: "You have exceeded a secondary rate limit. Please wait "
      + "a few minutes before you try again.  -- same GitHub docs page, 'About secondary rate "
      + "limits'; HTTP status is 403 or 429 per that page",
    composedGhErrorTextExample: "HTTP 403: API rate limit exceeded for <user-or-app>. "
      + "(https://api.github.com/...)",
    ghExitCode: "1 -- gh has no special-cased exit code for a rate-limited HTTPError; every "
      + "RunE error (including this one) falls through to gh's generic 'print err, exit 1' path "
      + "(pkg/cmd/root, confirmed by reading cli/cli's command error handling; no HTTPError "
      + "branch anywhere sets a different os.Exit code)",
  },
};

console.log(JSON.stringify(results, null, 2));
console.log(`\nscratch dir (raw gh api rate_limit output): ${ROOT}`);
