#!/usr/bin/env node
// Token guard live probes (#1935): for each key, A/B a real `omp --mode rpc-ui` against a scripted local
// provider in scratch dirs, repeat for two consecutive runs, print one verdict line per key, write a JSON report.
// Usage: node scripts/token-guard-probe/run.mjs [--out report.json] [--group a,b] [--runs 2] [--scratch-root dir]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deriveVerdict } from './ab.mjs';
import { assertScratchRootSafe, formatLine, parseArgs, selectGroups } from './cli.mjs';
import { GROUPS } from './groups.mjs';
import { defaultScratchRoot, ompVersion, realProfileDirs, startHost } from './host.mjs';
import { startProvider } from './provider.mjs';

const CONFIG_SETTLE_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Builds the ctx a key's `run` sees, tracking every host/provider it starts so they are always stopped. */
function makeContext(mode, scratchRoot, label) {
  const started = [];
  return {
    mode,
    async start({ script, config, models, files } = {}) {
      const provider = await startProvider({ script });
      started.push(() => provider.close());
      const host = await startHost({ label: `${label}-${mode}`, scratchRoot, provider, config, models, files, configSettleMs: CONFIG_SETTLE_MS });
      started.push(() => host.stop());
      return { host, provider };
    },
    // Why: control waits as long as a real edit would, so only the edit differs between the two modes.
    async edit(host, key, value) {
      if (mode === 'test') await host.setConfig(key, value);
      else await sleep(CONFIG_SETTLE_MS);
    },
    async dispose() {
      for (const stop of started.reverse()) await stop().catch(() => {});
    },
  };
}

async function runPass(entry, mode, scratchRoot) {
  const ctx = makeContext(mode, scratchRoot, entry.key.replace(/[^A-Za-z0-9]/g, '-'));
  try {
    return await entry.run(ctx);
  } catch (err) {
    // Why: a pass that throws has no observable; the verdict logic downgrades it instead of aborting every key.
    return { before: undefined, after: undefined, error: String(err?.message ?? err) };
  } finally {
    await ctx.dispose();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const names = selectGroups(GROUPS, args.groups);
  const scratchRoot = path.resolve(args.scratchRoot ?? defaultScratchRoot());
  assertScratchRootSafe(scratchRoot, realProfileDirs());
  const report = { omp: ompVersion(), startedAt: new Date().toISOString(), runs: args.runs, scratchRoot, results: [] };
  console.log(`${report.omp}; scratch ${scratchRoot}; groups ${names.join(', ')}; runs ${args.runs}`);

  for (const name of names) {
    for (const entry of GROUPS[name].keys) {
      const runs = [];
      for (let i = 0; i < args.runs; i++) {
        const control = await runPass(entry, 'control', scratchRoot);
        const test = await runPass(entry, 'test', scratchRoot);
        runs.push({ control, test });
      }
      const { verdict, reason, outcomes } = deriveVerdict(runs);
      const result = { key: entry.key, group: name, verdict, reason, outcomes, observable: entry.observable, runs };
      report.results.push(result);
      console.log(formatLine(result));
    }
  }

  report.finishedAt = new Date().toISOString();
  const out = path.resolve(args.out ?? path.join(scratchRoot, `report-${Date.now()}.json`));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`report: ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
