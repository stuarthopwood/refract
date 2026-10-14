#!/usr/bin/env node
// Issue #519 (re-scoped into #795 part 4, Epic #797, lane R12b): a full codegen of
// `src/shared/frames.ts`/new Rust wire structs from OMP's own published RPC schema is out of
// scope for this slice -- too risky against in-flight lanes editing those exact files (R3/#786
// owns session/agent + ipc/mod.rs; `frames.ts`/`model.ts`/`ipc.ts` are the single most shared
// files in the repo). This script is the safe subset: it proves "a schema change shows up as a
// diff" against a pinned, vendored copy of OMP's generated RPC wire schema, without writing to
// any of those files.
//
// IMPORTANT -- read before trusting this script's "unexpected registration" table: Refract's own
// `IPC_REQUESTS`/`IPC_EVENTS` (src/shared/ipc.ts) are a COMPLETELY DIFFERENT namespace from OMP's
// RPC command surface. `IPC_REQUESTS`/`IPC_EVENTS` name Refract's own Tauri/Electron IPC channels
// between its renderer and main/native process (e.g. `sessions.open`, `repositories.list`) -- they
// are not, and were never meant to be, a 1:1 mirror of OMP's `negotiate_protocol`/`get_state`/
// `prompt` RPC command set. The "channels with no same/similarly-named OMP command" table below is
// PURELY INFORMATIONAL (most rows will not match, by design) and is NOT a parity gate: it never
// affects this script's exit code.
//
// The actually useful drift signal is the second check: every OMP wire command name or frame/part
// "type" tag that `src/main/omp/OmpProcess.ts`, `src-tauri/src/omp/process.rs`, and
// `src-tauri/src/omp/transcript.rs` reference BY STRING LITERAL, cross-checked against the
// vendored schema + generated-types text (scripts/fixtures/omp-schema/). A literal referenced by
// Refract's own OMP transport/transcript code that does not appear anywhere in OMP's own published
// schema is a real signal: either a typo in Refract's code, or a schema that has gone stale
// relative to what Refract actually relies on. THIS check does set the exit code.
//
// Usage:
//   node scripts/check-omp-schema-drift.mjs               Run the drift checks (exit 1 on any
//                                                           undeclared wire literal, 0 otherwise).
//   node scripts/check-omp-schema-drift.mjs --check-pin    Also (non-fatally) compare the pinned
//                                                           package version in PROVENANCE.md
//                                                           against the current npm registry
//                                                           version. Always exits 0 regardless of
//                                                           the comparison result -- a newer
//                                                           upstream package existing is
//                                                           informational, not a failure.
//
// Regex-based scan, not a real TS/Rust parser -- "good enough" per this slice's own brief: it
// recognises a small, deliberately curated set of syntactic shapes (see `extractReferencedWireLiterals`
// below) rather than attempting full language-aware analysis.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const schemaDir = path.join(__dirname, 'fixtures', 'omp-schema');

function readFile(p) {
  return readFileSync(p, 'utf8');
}

function relPath(p) {
  return path.relative(repoRoot, p).replace(/\\/g, '/');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// 1. Load the vendored schema + generated-types text, and the command name list.
// ---------------------------------------------------------------------------

const schemaPath = path.join(schemaDir, 'rpc-wire.schema.json');
const generatedPath = path.join(schemaDir, 'rpc-wire.generated.ts');
const provenancePath = path.join(schemaDir, 'PROVENANCE.md');

const schemaRaw = readFile(schemaPath);
const generatedRaw = readFile(generatedPath);
const schemaJson = JSON.parse(schemaRaw);

const commands = schemaJson['x-rpc']?.commands;
if (!Array.isArray(commands)) {
  throw new Error(`check-omp-schema-drift: could not find x-rpc.commands[] in ${relPath(schemaPath)}`);
}
const commandNames = commands.map((c) => c.name);

const generatedTypeNameRe = /export (?:interface|type) (\w+)/g;
const generatedTypeNames = [];
{
  let m;
  while ((m = generatedTypeNameRe.exec(generatedRaw))) generatedTypeNames.push(m[1]);
}

// The full text of both vendored files is the reference corpus for the wire-literal drift check
// below: a literal counts as "known" if it appears anywhere in this text (a schema `const` value,
// a discriminated-union member name, or even just prose in a doc comment/description -- e.g.
// `rpc_chunk` is only ever mentioned in a description string, never as a discriminated frame-type
// value, because it is a pre-reassembly transport artifact consumed before a frame is decoded; it
// is still legitimately "known to the schema docs", not a typo).
const knownTextCorpus = schemaRaw + '\n' + generatedRaw;
function isKnownLiteral(literal) {
  return new RegExp(`\\b${escapeRegExp(literal)}\\b`).test(knownTextCorpus);
}

// ---------------------------------------------------------------------------
// 2. Informational table: Refract's own IPC_REQUESTS/IPC_EVENTS channels with no same/similarly
//    named OMP command. See header comment -- this never affects the exit code.
// ---------------------------------------------------------------------------

function extractConstObject(source, constName) {
  const match = source.match(new RegExp(`export const ${constName} = \\{([\\s\\S]*?)\\n\\} as const;`));
  if (!match) throw new Error(`check-omp-schema-drift: could not find ${constName} in src/shared/ipc.ts`);
  const entries = [];
  const entryRe = /^\s*([A-Z0-9_]+):\s*'([^']+)',?\s*$/gm;
  let m;
  while ((m = entryRe.exec(match[1]))) entries.push({ key: m[1], value: m[2] });
  return entries;
}

const ipcTsPath = path.join(repoRoot, 'src', 'shared', 'ipc.ts');
const ipcSource = readFile(ipcTsPath);
const ipcRequests = extractConstObject(ipcSource, 'IPC_REQUESTS');
const ipcEvents = extractConstObject(ipcSource, 'IPC_EVENTS');

// A channel's last dot-segment, snake_cased, is the closest a Refract channel name gets to an OMP
// command name (e.g. `sessions.open` -> `open`; `accounts.omp.signIn` -> `sign_in`). Loose, by
// design: this table is informational only.
function toCommandLikeFragment(channelValue) {
  const lastSegment = channelValue.split('.').pop() ?? channelValue;
  return lastSegment.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

const commandNameSet = new Set(commandNames);
const unmatchedChannels = [...ipcRequests, ...ipcEvents].filter(({ value }) => {
  const fragment = toCommandLikeFragment(value);
  return !commandNameSet.has(fragment) && !commandNames.some((n) => n.includes(fragment) || fragment.includes(n));
});

// ---------------------------------------------------------------------------
// 3. The real drift signal: OMP wire literals Refract's own transport/transcript code reads or
//    writes by string, that do not appear anywhere in the vendored schema text.
// ---------------------------------------------------------------------------

const scanTargets = [
  path.join(repoRoot, 'src', 'main', 'omp', 'OmpProcess.ts'),
  path.join(repoRoot, 'src-tauri', 'src', 'omp', 'process.rs'),
  path.join(repoRoot, 'src-tauri', 'src', 'omp', 'transcript.rs'),
];

// Finds the index just past the closing bracket matching the opener at `openIndex` (which must
// itself be one of `open`), counting nested `open`/`close` pairs. Used to carve out the body of a
// `matches!( ... )` call or a `match ... { ... }` block without assuming no nested parens/braces.
function findMatchingClose(text, openIndex, open, close) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Regex-based, deliberately narrow extraction (see module header): recognises only syntactic
// shapes actually used by this codebase's OMP transport/transcript code to name a wire command or
// frame/part "type" tag. A variable name containing "type" (frame_type, part_type, ...) is the
// heuristic that separates a real type-tag match/comparison from an unrelated string match (e.g.
// `is_advisory_severity`'s `matches!(value, "nit" | "concern" | "blocker")` is skipped because its
// discriminant is named `value`, not `*type*`).
function extractReferencedWireLiterals(source) {
  const found = new Map(); // literal -> Set of match-kind labels (for the report)

  function record(literal, kind) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(literal)) return;
    if (!found.has(literal)) found.set(literal, new Set());
    found.get(literal).add(kind);
  }

  // (a) `frame.type === 'x'` / `frame.type !== 'x'` / `frame["type"] === 'x'` (TS).
  {
    const re = /\bframe(?:\.type|\[\s*['"]type['"]\s*\])\s*[!=]==\s*['"]([A-Za-z0-9_]+)['"]/g;
    let m;
    while ((m = re.exec(source))) record(m[1], 'frame.type compare');
  }

  // (b) `type: 'x'` / `"type": "x"` key-value in an outbound command/frame object literal (TS
  // `this.request({ type: '...' })`, Rust `json!({ "type": "..." })`).
  {
    const re = /["']?\btype\b["']?\s*:\s*["']([A-Za-z0-9_]+)["']/g;
    let m;
    while ((m = re.exec(source))) record(m[1], "'type:' key");
  }

  // (c) Rust `<ident containing "type"> == "literal"` equality (e.g. `frame_type == "rpc_chunk"`).
  {
    const re = /\b(\w*[Tt]ype\w*)\s*==\s*"([A-Za-z0-9_]+)"/g;
    let m;
    while ((m = re.exec(source))) record(m[2], `${m[1]} ==`);
  }

  // (d) Rust `matches!(<ident containing "type">, "a" | "b" | ...)`.
  {
    const headerRe = /matches!\(\s*(\w*[Tt]ype\w*)\s*,/g;
    let m;
    while ((m = headerRe.exec(source))) {
      const openIndex = source.indexOf('(', m.index);
      const closeIndex = findMatchingClose(source, openIndex, '(', ')');
      if (closeIndex === -1) continue;
      const body = source.slice(openIndex + 1, closeIndex);
      const litRe = /"([A-Za-z0-9_]+)"/g;
      let lm;
      while ((lm = litRe.exec(body))) record(lm[1], `matches!(${m[1]}, ...)`);
    }
  }

  // (e) Rust `match <ident containing "type"> { "a" => ..., "b" => ... }`.
  {
    const headerRe = /match\s+(\w*[Tt]ype\w*)\s*\{/g;
    let m;
    while ((m = headerRe.exec(source))) {
      const openIndex = source.indexOf('{', m.index);
      const closeIndex = findMatchingClose(source, openIndex, '{', '}');
      if (closeIndex === -1) continue;
      const body = source.slice(openIndex + 1, closeIndex);
      const armRe = /"([A-Za-z0-9_]+)"\s*=>/g;
      let am;
      while ((am = armRe.exec(body))) record(am[1], `match ${m[1]} { ... }`);
    }
  }

  return found;
}

const undeclared = []; // [{ literal, kinds: string[], file }]
const allReferenced = new Map(); // literal -> Set(file)

for (const file of scanTargets) {
  const source = readFile(file);
  const literals = extractReferencedWireLiterals(source);
  for (const [literal, kinds] of literals) {
    if (!allReferenced.has(literal)) allReferenced.set(literal, new Set());
    allReferenced.get(literal).add(relPath(file));
    if (!isKnownLiteral(literal)) {
      undeclared.push({ literal, kinds: [...kinds], file: relPath(file) });
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Print.
// ---------------------------------------------------------------------------

function printTable(rows, columns) {
  const widths = columns.map((c) => Math.max(c.header.length, ...rows.map((r) => String(r[c.key] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(columns.map((c) => c.header)));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(columns.map((c) => row[c.key] ?? '')));
}

console.log(`check-omp-schema-drift: vendored schema ${relPath(schemaPath)}`);
console.log(`  x-rpc.commands: ${commandNames.length}   generated type/interface exports: ${generatedTypeNames.length}`);
console.log();

console.log('-- 1. INFORMATIONAL ONLY (not a parity gate, see header comment) --------------------');
console.log(`Refract IPC_REQUESTS/IPC_EVENTS channels with no same/similarly-named OMP command:`);
if (unmatchedChannels.length === 0) {
  console.log('  (none)');
} else {
  printTable(
    unmatchedChannels.map((r) => ({ channel: r.key, value: r.value })),
    [
      { header: 'channel', key: 'channel' },
      { header: 'value', key: 'value' },
    ],
  );
}
console.log(`unmatched: ${unmatchedChannels.length} of ${ipcRequests.length + ipcEvents.length} total channels`);
console.log();

console.log('-- 2. REAL DRIFT SIGNAL: OMP wire literals Refract references by name ---------------');
console.log(`Scanned: ${scanTargets.map(relPath).join(', ')}`);
console.log(`Distinct wire literals referenced: ${allReferenced.size}`);
if (undeclared.length === 0) {
  console.log('  All referenced literals are present in the vendored schema text. No drift detected.');
} else {
  console.log('  UNDECLARED literal(s) -- referenced by Refract but absent from the vendored schema:');
  printTable(
    undeclared.map((r) => ({ literal: r.literal, file: r.file, matchedAs: r.kinds.join(', ') })),
    [
      { header: 'literal', key: 'literal' },
      { header: 'file', key: 'file' },
      { header: 'matched as', key: 'matchedAs' },
    ],
  );
}
console.log();

// ---------------------------------------------------------------------------
// 5. --check-pin: informational-only, never affects exit code.
// ---------------------------------------------------------------------------

if (process.argv.includes('--check-pin')) {
  const provenance = readFile(provenancePath);
  const pinnedMatch = provenance.match(/@oh-my-pi\/pi-coding-agent@([0-9.]+)/);
  const pinnedVersion = pinnedMatch?.[1];
  if (!pinnedVersion) {
    console.log(`--check-pin: could not find a pinned version in ${relPath(provenancePath)}`);
  } else {
    let registryVersion;
    try {
      registryVersion = execFileSync('npm', ['view', '@oh-my-pi/pi-coding-agent', 'version'], {
        encoding: 'utf8',
        shell: true,
      }).trim();
    } catch (err) {
      console.log(`--check-pin: \`npm view @oh-my-pi/pi-coding-agent version\` failed: ${err.message}`);
      registryVersion = undefined;
    }
    if (registryVersion) {
      console.log(`--check-pin: pinned ${pinnedVersion}, npm registry latest ${registryVersion}`);
      if (registryVersion !== pinnedVersion) {
        console.log(
          `--check-pin: WARNING -- pinned schema (${pinnedVersion}) is behind the npm registry's published omp (${registryVersion}). Consider re-vendoring scripts/fixtures/omp-schema/.`,
        );
      } else {
        console.log('--check-pin: pinned schema matches the current npm registry version.');
      }
    }
  }
}

process.exit(undeclared.length > 0 ? 1 : 0);
