#!/usr/bin/env node
// Issue #519 (re-scoped into #795 part 4, Epic #797, lane R12b): a full codegen of
// `src/shared/frames.ts`/new Rust wire structs from OMP's own published RPC schema is out of
// scope for this slice -- too risky against in-flight lanes editing those exact files (R3/#786
// owns session/agent + ipc/mod.rs; `frames.ts`/`model.ts`/`ipc.ts` are the single most shared
// files in the repo). This script is the safe subset: it proves "a schema change shows up as a
// diff" against a pinned, vendored copy of OMP's published RPC wire schema, without writing to
// any of those files.
//
// IMPORTANT -- read before trusting this script's "unexpected registration" table: Refract's own
// `IPC_REQUESTS`/`IPC_EVENTS` (src/shared/ipc.ts) are a COMPLETELY DIFFERENT namespace from OMP's
// RPC command surface. `IPC_REQUESTS`/`IPC_EVENTS` name Refract's own Tauri/Electron IPC channels
// between its renderer and main/native process (e.g. `sessions.open`, `repositories.list`) -- they
// are not, and were never meant to be, a 1:1 mirror of OMP's `negotiate_protocol`/`get_state`/
// `prompt` RPC command set. The "channels with no same/similarly-named OMP command" table below is
// PURELY INFORMATIONAL (most rows will not match, by design) and is NOT a parity gate: it never
// affects this script's exit code. That table's extraction degrades to a printed warning (not a
// crash) if `src/shared/ipc.ts`'s `IPC_REQUESTS`/`IPC_EVENTS` shape ever changes shape (e.g. a
// `satisfies`-style refactor) -- only the real wire-literal drift check below ever sets a non-zero
// exit code.
//
// The actually useful drift signal is the second check: every OMP wire command name or frame/part
// "type" tag that Refract's own OMP transport/transcript/session code references BY STRING LITERAL
// (see `scanTargets` below -- both the TypeScript Electron-side modules and the Rust Tauri-side
// modules that talk to the real `omp` process), cross-checked against the vendored schema's own
// declared vocabulary: its `x-rpc.commands[].name` list plus every `const`/`enum` discriminant
// value anywhere in its `$defs`. These are the only strings OMP's own schema actually declares as
// wire-level identifiers; matching against the full schema TEXT (prose, descriptions, unrelated
// English words) would both false-pass typos that happen to appear in a doc comment and false-pass
// a genuinely removed command if any surviving sentence still mentions it. A literal referenced by
// Refract's own code that is not in that declared vocabulary (and not in the small, explicitly
// named `KNOWN_TRANSPORT_ONLY_LITERALS` allowlist below) is a real signal: either a typo in
// Refract's code, or a schema that has gone stale relative to what Refract actually relies on.
// THIS check does set the exit code.
//
// Usage:
//   node scripts/check-omp-schema-drift.mjs               Run the drift checks (exit 1 on any
//                                                           undeclared wire literal, 0 otherwise).
//   node scripts/check-omp-schema-drift.mjs --check-pin    Also (non-fatally) compare the pinned
//                                                           package version in PROVENANCE.md
//                                                           against the current npm registry
//                                                           version. Always exits 0 regardless of
//                                                           the comparison result -- a newer (or
//                                                           older) upstream package existing is
//                                                           informational, not a failure.
//   node scripts/check-omp-schema-drift.mjs --self-test    Gate infrastructure, not a product
//                                                           check: seeds deliberately undeclared
//                                                           literals and asserts this script's own
//                                                           detection logic actually flags them
//                                                           (proving the detector CAN fail, rather
//                                                           than silently false-passing). Exits 1
//                                                           if any self-test assertion fails, 0
//                                                           otherwise; does not touch scanTargets.
//
// Regex-based scan, not a real TS/Rust parser -- "good enough" per this slice's own brief: it
// recognises a small, deliberately curated set of syntactic shapes (see `extractReferencedWireLiterals`
// below) rather than attempting full language-aware analysis.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const schemaDir = path.join(__dirname, "fixtures", "omp-schema");

function readFile(p) {
  return readFileSync(p, "utf8");
}

function relPath(p) {
  return path.relative(repoRoot, p).replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// 1. Load the vendored schema and the command name list.
// ---------------------------------------------------------------------------

const schemaPath = path.join(schemaDir, "rpc-wire.schema.json");
const provenancePath = path.join(schemaDir, "PROVENANCE.md");

const schemaRaw = readFile(schemaPath);
const schemaJson = JSON.parse(schemaRaw);

const commands = schemaJson["x-rpc"]?.commands;
if (!Array.isArray(commands)) {
  throw new Error(
    `check-omp-schema-drift: could not find x-rpc.commands[] in ${relPath(schemaPath)}`,
  );
}
const commandNames = commands.map((c) => c.name);
const schemaDefNames = Object.keys(schemaJson.$defs ?? {});

// ---------------------------------------------------------------------------
// 2. The known-literal vocabulary: every string OMP's own schema actually declares as a wire-level
//    identifier -- x-rpc command names, plus every `const`/`enum` discriminant value anywhere in
//    the schema's `$defs` (these are the frame/part "type" tags and other discriminated-union
//    member names the generated TS types encode as literal unions). A literal counts as "known"
//    only if it is one of these declared values, or is in the small allowlist below.
// ---------------------------------------------------------------------------

function collectDeclaredLiterals(defs) {
  const literals = new Set();
  function walk(node) {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node.const === "string") literals.add(node.const);
    if (Array.isArray(node.enum)) {
      for (const v of node.enum) if (typeof v === "string") literals.add(v);
    }
    for (const key of Object.keys(node)) walk(node[key]);
  }
  walk(defs);
  return literals;
}

const declaredLiterals = collectDeclaredLiterals(schemaJson.$defs ?? {});
for (const name of commandNames) declaredLiterals.add(name);

// A handful of real transport-only literals exist by design outside the command/const/enum
// vocabulary above: OMP's schema only ever mentions them in prose, because they name a protocol
// detail the schema documents but does not model as a discriminated field. Each entry below is
// named explicitly with a one-line reason -- this is NOT a general escape hatch.
const KNOWN_TRANSPORT_ONLY_LITERALS = new Set([
  // `rpc_chunk`: the pre-reassembly stdout chunk-framing tag (0xA0-delimited, correlated by
  // `chunkId`) that `src-tauri/src/omp/process.rs`'s chunk reassembly and `OmpProcess.ts`'s
  // mirror both switch on. It is consumed and reassembled into a real frame *before* that frame is
  // decoded, so the schema's `ServerFrame` discriminated union (the thing `$defs` walk above
  // extracts `const`/`enum` values from) never lists it as one of its own `type` values -- the
  // schema's top-level description for that union says as much ("after reassembling `rpc_chunk`
  // sequences"), prose only, never a declared discriminant.
  "rpc_chunk",
]);

function isKnownLiteral(literal) {
  return (
    declaredLiterals.has(literal) || KNOWN_TRANSPORT_ONLY_LITERALS.has(literal)
  );
}

// ---------------------------------------------------------------------------
// 3. Literal-reference extraction, shared by the real scan (section 5) and --self-test (below).
// ---------------------------------------------------------------------------

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

// Bracket-nesting depth of `text` at `index`, counting `{`/`(`/`[` pairs from the start of `text`.
// Used to tell a top-level match arm (depth 0 within the carved-out match body) apart from an arm
// belonging to some OTHER match/matches! block nested inside one of the outer arms (e.g. an
// unrelated `match <severity>` nested inside a `match frame_type` arm) -- a regex scan over the
// whole carved body with no depth check would wrongly attribute that nested match's own arms to
// the outer "type" match.
function topLevelDepthAt(text, index) {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
  }
  return depth;
}

// Regex-based, deliberately narrow extraction (see module header): recognises only syntactic
// shapes actually used by this codebase's OMP transport/transcript/session code to name a wire
// command or frame/part "type" tag. A variable name containing "type" (frame_type, part_type, ...)
// is the heuristic that separates a real type-tag match/comparison from an unrelated string match
// (e.g. `is_advisory_severity`'s `matches!(value, "nit" | "concern" | "blocker")` is skipped
// because its discriminant is named `value`, not `*type*`).
function extractReferencedWireLiterals(source) {
  const found = new Map(); // literal -> Set of match-kind labels (for the report)

  function record(literal, kind) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(literal)) return;
    if (!found.has(literal)) found.set(literal, new Set());
    found.get(literal).add(kind);
  }

  // (a) `frame.type === 'x'` / `frame.type !== 'x'` / `frame["type"] === 'x'` (TS).
  {
    const re =
      /\bframe(?:\.type|\[\s*['"]type['"]\s*\])\s*[!=]==\s*['"]([A-Za-z0-9_]+)['"]/g;
    let m;
    while ((m = re.exec(source))) record(m[1], "frame.type compare");
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
      const openIndex = source.indexOf("(", m.index);
      const closeIndex = findMatchingClose(source, openIndex, "(", ")");
      if (closeIndex === -1) continue;
      const body = source.slice(openIndex + 1, closeIndex);
      const litRe = /"([A-Za-z0-9_]+)"/g;
      let lm;
      while ((lm = litRe.exec(body))) record(lm[1], `matches!(${m[1]}, ...)`);
    }
  }

  // (e) Rust `match <ident containing "type"> { "a" => ..., "b" | "c" => ... }`. Captures EVERY
  // alternative of a `|`-joined arm pattern (not just the one immediately before `=>`), and only
  // arms at the match body's own top level (see `topLevelDepthAt`) -- a nested match/matches!
  // block inside one of this match's arms does not leak its own arms into this scan.
  {
    const headerRe = /match\s+(\w*[Tt]ype\w*)\s*\{/g;
    let m;
    while ((m = headerRe.exec(source))) {
      const openIndex = source.indexOf("{", m.index);
      const closeIndex = findMatchingClose(source, openIndex, "{", "}");
      if (closeIndex === -1) continue;
      const body = source.slice(openIndex + 1, closeIndex);
      const armRe = /((?:"[A-Za-z0-9_]+"\s*\|\s*)*"[A-Za-z0-9_]+")\s*=>/g;
      let am;
      while ((am = armRe.exec(body))) {
        if (topLevelDepthAt(body, am.index) !== 0) continue;
        const alternatives = am[1]
          .split("|")
          .map((s) => s.trim().replace(/^"|"$/g, ""));
        for (const alt of alternatives) record(alt, `match ${m[1]} { ... }`);
      }
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// --self-test: gate infrastructure, not a product check (see module header usage note). Seeds
// literals this script has never declared anywhere and asserts its own detection logic actually
// catches them, so a future refactor that accidentally makes `isKnownLiteral`/
// `extractReferencedWireLiterals` false-pass everything fails loudly here first. Runs before any
// repo file other than the vendored schema is touched, and exits immediately.
// ---------------------------------------------------------------------------

function selfTest() {
  const failures = [];
  const seed = "definitely_undeclared_self_test_literal_8f3a";

  if (!isKnownLiteral("prompt")) {
    failures.push(
      'isKnownLiteral("prompt") should be true: it is a real x-rpc.commands[] name.',
    );
  }
  if (isKnownLiteral(seed)) {
    failures.push(
      `isKnownLiteral(${JSON.stringify(seed)}) should be false: it was seeded as undeclared.`,
    );
  }

  const seededSource = [
    `frame.type === '${seed}_a'`,
    `const req = { type: '${seed}_b' };`,
    `frame_type == "${seed}_c"`,
    `matches!(frame_type, "${seed}_d")`,
    `match frame_type { "${seed}_e" | "${seed}_f" => {} }`,
  ].join("\n");
  const found = extractReferencedWireLiterals(seededSource);
  for (const suffix of ["a", "b", "c", "d", "e", "f"]) {
    const literal = `${seed}_${suffix}`;
    if (!found.has(literal)) {
      failures.push(
        `extractReferencedWireLiterals did not find seeded literal ${literal} (shape ${suffix}).`,
      );
    } else if (isKnownLiteral(literal)) {
      failures.push(
        `isKnownLiteral(${literal}) should be false: it was seeded as undeclared.`,
      );
    }
  }

  return failures;
}

if (process.argv.includes("--self-test")) {
  const failures = selfTest();
  if (failures.length === 0) {
    console.log(
      "check-omp-schema-drift --self-test: PASS -- detector flags every seeded undeclared literal " +
        "(all five extraction shapes, including every alternative of a multi-arm match) and still " +
        "recognises a real command name.",
    );
    process.exit(0);
  }
  console.log("check-omp-schema-drift --self-test: FAIL");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. Informational table: Refract's own IPC_REQUESTS/IPC_EVENTS channels with no same/similarly
//    named OMP command. See header comment -- this never affects the exit code. Degrades to a
//    printed warning (not a throw) if src/shared/ipc.ts's IPC_REQUESTS/IPC_EVENTS shape changes.
// ---------------------------------------------------------------------------

function extractConstObject(source, constName) {
  const match = source.match(
    new RegExp(`export const ${constName} = \\{([\\s\\S]*?)\\n\\} as const;`),
  );
  if (!match)
    throw new Error(
      `check-omp-schema-drift: could not find ${constName} in src/shared/ipc.ts`,
    );
  const entries = [];
  const entryRe = /^\s*([A-Z0-9_]+):\s*'([^']+)',?\s*$/gm;
  let m;
  while ((m = entryRe.exec(match[1]))) entries.push({ key: m[1], value: m[2] });
  return entries;
}

// A channel's last dot-segment, snake_cased, is the closest a Refract channel name gets to an OMP
// command name (e.g. `sessions.open` -> `open`; `accounts.omp.signIn` -> `sign_in`). Loose, by
// design: this table is informational only.
function toCommandLikeFragment(channelValue) {
  const lastSegment = channelValue.split(".").pop() ?? channelValue;
  return lastSegment.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

let ipcRequests = [];
let ipcEvents = [];
let unmatchedChannels = [];
let ipcParseWarning = null;
try {
  const ipcTsPath = path.join(repoRoot, "src", "shared", "ipc.ts");
  const ipcSource = readFile(ipcTsPath);
  ipcRequests = extractConstObject(ipcSource, "IPC_REQUESTS");
  ipcEvents = extractConstObject(ipcSource, "IPC_EVENTS");
  const commandNameSet = new Set(commandNames);
  unmatchedChannels = [...ipcRequests, ...ipcEvents].filter(({ value }) => {
    const fragment = toCommandLikeFragment(value);
    return (
      !commandNameSet.has(fragment) &&
      !commandNames.some((n) => n.includes(fragment) || fragment.includes(n))
    );
  });
} catch (err) {
  ipcParseWarning = err.message;
}

// ---------------------------------------------------------------------------
// 5. The real drift signal: OMP wire literals Refract's own transport/transcript/session code
//    reads or writes by string, that are not in the schema's declared vocabulary (section 2).
// ---------------------------------------------------------------------------

const sessionAgentDir = path.join(
  repoRoot,
  "src-tauri",
  "src",
  "session",
  "agent",
);
const scanTargets = [
  path.join(repoRoot, "src", "shared", "frames.ts"),
  path.join(repoRoot, "src", "main", "omp", "OmpProcess.ts"),
  path.join(repoRoot, "src", "main", "omp", "SessionAgent.ts"),
  path.join(repoRoot, "src", "main", "omp", "dialogs.ts"),
  path.join(repoRoot, "src-tauri", "src", "omp", "process.rs"),
  path.join(repoRoot, "src-tauri", "src", "omp", "transcript.rs"),
  // R3/#786 (PR #827) owns every file in this directory -- read-only here, grep-scanned for its
  // wire-literal references only, never edited.
  ...readdirSync(sessionAgentDir)
    .filter((f) => f.endsWith(".rs"))
    .sort()
    .map((f) => path.join(sessionAgentDir, f)),
];

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
// 6. Print.
// ---------------------------------------------------------------------------

function printTable(rows, columns) {
  const widths = columns.map((c) =>
    Math.max(
      c.header.length,
      ...rows.map((r) => String(r[c.key] ?? "").length),
    ),
  );
  const line = (cells) =>
    cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  console.log(line(columns.map((c) => c.header)));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows)
    console.log(line(columns.map((c) => row[c.key] ?? "")));
}

console.log(`check-omp-schema-drift: vendored schema ${relPath(schemaPath)}`);
console.log(
  `  x-rpc.commands: ${commandNames.length}   schema $defs entries: ${schemaDefNames.length}`,
);
console.log();

console.log(
  "-- 1. INFORMATIONAL ONLY (not a parity gate, see header comment) --------------------",
);
console.log(
  `Refract IPC_REQUESTS/IPC_EVENTS channels with no same/similarly-named OMP command:`,
);
if (ipcParseWarning) {
  console.log(
    `  could not parse IPC_REQUESTS/IPC_EVENTS for this informational table; skipping it.`,
  );
  console.log(`  (${ipcParseWarning})`);
} else if (unmatchedChannels.length === 0) {
  console.log("  (none)");
} else {
  printTable(
    unmatchedChannels.map((r) => ({ channel: r.key, value: r.value })),
    [
      { header: "channel", key: "channel" },
      { header: "value", key: "value" },
    ],
  );
  console.log(
    `unmatched: ${unmatchedChannels.length} of ${ipcRequests.length + ipcEvents.length} total channels`,
  );
}
console.log();

console.log(
  "-- 2. REAL DRIFT SIGNAL: OMP wire literals Refract references by name ---------------",
);
console.log(`Scanned: ${scanTargets.map(relPath).join(", ")}`);
console.log(`Distinct wire literals referenced: ${allReferenced.size}`);
if (undeclared.length === 0) {
  console.log(
    "  All referenced literals are present in the vendored schema. No drift detected.",
  );
} else {
  console.log(
    "  UNDECLARED literal(s) -- referenced by Refract but absent from the vendored schema:",
  );
  printTable(
    undeclared.map((r) => ({
      literal: r.literal,
      file: r.file,
      matchedAs: r.kinds.join(", "),
    })),
    [
      { header: "literal", key: "literal" },
      { header: "file", key: "file" },
      { header: "matched as", key: "matchedAs" },
    ],
  );
}
console.log();

// ---------------------------------------------------------------------------
// 7. --check-pin: informational-only, never affects exit code.
// ---------------------------------------------------------------------------

if (process.argv.includes("--check-pin")) {
  const provenance = readFile(provenancePath);
  const pinnedMatch = provenance.match(/@oh-my-pi\/pi-coding-agent@([0-9.]+)/);
  const pinnedVersion = pinnedMatch?.[1];
  if (!pinnedVersion) {
    console.log(
      `--check-pin: could not find a pinned version in ${relPath(provenancePath)}`,
    );
  } else {
    let registryVersion;
    try {
      // Windows cannot spawn a `.cmd` shim directly without a shell since Node's
      // CVE-2024-27980 fix (`.bat`/`.cmd` execution now requires `{ shell: true }` or an
      // explicit interpreter) -- but `shell: true` builds one shell-parsed command-line string,
      // which is the real injection surface a security reviewer already flagged here. The safe
      // middle ground `cross-spawn` and Node's own advisory both point to: invoke `cmd.exe`
      // itself (a real, directly-executable .exe) as the file, with the actual command and its
      // args passed through as separate, un-concatenated argv elements -- same effect as a
      // shell, with none of the single-string quoting/injection risk, and it works with the
      // fully-static args below (no untrusted input ever reaches this call).
      const [bin, args] =
        process.platform === "win32"
          ? [
              "cmd.exe",
              [
                "/d",
                "/s",
                "/c",
                "npm",
                "view",
                "@oh-my-pi/pi-coding-agent",
                "version",
              ],
            ]
          : ["npm", ["view", "@oh-my-pi/pi-coding-agent", "version"]];
      registryVersion = execFileSync(bin, args, { encoding: "utf8" }).trim();
    } catch (err) {
      console.log(
        `--check-pin: \`npm view @oh-my-pi/pi-coding-agent version\` failed: ${err.message}`,
      );
      registryVersion = undefined;
    }
    if (registryVersion) {
      console.log(
        `--check-pin: pinned ${pinnedVersion}, npm registry latest ${registryVersion}`,
      );
      const cmp = compareSemver(pinnedVersion, registryVersion);
      if (cmp === 0) {
        console.log(
          "--check-pin: pinned schema matches the current npm registry version.",
        );
      } else if (cmp < 0) {
        console.log(
          `--check-pin: WARNING -- pinned schema (${pinnedVersion}) differs from the npm registry's ` +
            `published omp (${registryVersion}, newer). Consider re-vendoring scripts/fixtures/omp-schema/.`,
        );
      } else {
        console.log(
          `--check-pin: WARNING -- pinned schema (${pinnedVersion}) differs from the npm registry's ` +
            `published omp (${registryVersion}, OLDER than the pin). Unexpected -- verify the pin before relying on it.`,
        );
      }
    }
  }
}

// Cheap numeric semver comparison (dotted non-negative integers only, which is all this pin ever
// uses): returns -1 if `a` < `b`, 0 if equal, 1 if `a` > `b`.
function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

process.exit(undeclared.length > 0 ? 1 : 0);
