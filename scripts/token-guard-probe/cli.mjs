// Pure CLI helpers for run.mjs (#1935): argument parsing, group selection and the per-key output line.

const flag = (argv, i, name) => {
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
};

export function parseArgs(argv) {
  const out = { out: null, groups: [], runs: 2, scratchRoot: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '--out') out.out = flag(argv, i++, a);
    else if (a === '--group') out.groups.push(...flag(argv, i++, a).split(',').filter(Boolean));
    else if (a === '--runs') {
      out.runs = Number(flag(argv, i++, a));
      if (!Number.isInteger(out.runs) || out.runs < 1) throw new Error('--runs must be a positive integer');
    } else if (a === '--scratch-root') out.scratchRoot = flag(argv, i++, a);
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

/**
 * `names` empty selects every non-smoke group; a named group may be a smoke group.
 * @param {Record<string, {smoke?: boolean}>} groups
 */
export function selectGroups(groups, names) {
  if (names.length === 0) return Object.keys(groups).filter((n) => !groups[n].smoke);
  const unknown = names.filter((n) => !(n in groups));
  if (unknown.length) throw new Error(`unknown group ${unknown.join(', ')}; known: ${Object.keys(groups).join(', ')}`);
  return [...new Set(names)];
}

const pair = (p) => `${JSON.stringify(p?.before)}->${JSON.stringify(p?.after)}`;

/** `key verdict observable control test`, using the last run's passes. */
export function formatLine({ key, verdict, observable, runs }) {
  const last = runs[runs.length - 1] ?? {};
  return [key, verdict, observable, `control ${pair(last.control)}`, `test ${pair(last.test)}`].join('\t');
}
