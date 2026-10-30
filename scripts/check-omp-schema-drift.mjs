#!/usr/bin/env node
// Proves an OMP RPC schema change shows up as a diff, against a vendored copy of OMP's published wire schema. Full codegen of
// `frames.ts`/Rust wire structs is out of scope (#519/#795): those files are the most shared in the repo and in flux across lanes.
//
// Two checks. The "channels with no similarly-named OMP command" table is informational only and never sets the exit code:
// Refract's `IPC_REQUESTS`/`IPC_EVENTS` (src/shared/ipc.ts) are Tauri channels, a different namespace from OMP's RPC commands,
// and extraction degrades to a warning if that file's shape changes. The real drift check cross-references every OMP wire
// command or frame/part "type" tag that Refract code references by string literal (`scanTargets`) against the schema's declared
// vocabulary (`x-rpc.commands[].name` plus `const`/`enum` values in `$defs`) and the `KNOWN_TRANSPORT_ONLY_LITERALS` allowlist.
// Matching against full schema text would false-pass typos and removed commands that prose still mentions. Only this check
// sets a non-zero exit code.
//
// Usage: `node scripts/check-omp-schema-drift.mjs [--check-pin | --self-test]`
//   --check-pin   also non-fatally compares the PROVENANCE.md pinned package version with the npm registry; always exits 0.
//   --self-test   seeds undeclared literals and asserts the detector flags them, proving it can fail; exits 1 on a failed assertion.
//
// Regex-based scan, not a TS/Rust parser: it recognises a small curated set of syntactic shapes (`extractReferencedWireLiterals`).

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

// Known vocabulary = x-rpc command names plus every `const`/`enum` discriminant in `$defs`.
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

// Transport-only literals the schema mentions only in prose; not a general escape hatch.
const KNOWN_TRANSPORT_ONLY_LITERALS = new Set([
  // `rpc_chunk` is reassembled into a real frame before decoding, so ServerFrame never declares it.
  "rpc_chunk",
]);

function isKnownLiteral(literal) {
  return (
    declaredLiterals.has(literal) || KNOWN_TRANSPORT_ONLY_LITERALS.has(literal)
  );
}

// Index of the bracket closing the opener at `openIndex`, counting nested pairs.
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

// Bracket depth at `index`; separates top-level arms from arms of a nested match, which would
// otherwise be wrongly attributed to the outer "type" match.
function topLevelDepthAt(text, index) {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
  }
  return depth;
}

// Matches only the syntactic shapes this codebase uses to name a wire command or "type" tag.
// A variable name containing "type" is the heuristic separating a type-tag match from an
// unrelated string match (e.g. `is_advisory_severity` matches on `value`, so it is skipped).
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

  // (e) Rust `match <ident containing "type"> { ... }`. Captures every `|` alternative, but only
  // top-level arms (`topLevelDepthAt`) so a nested match doesn't leak its arms into this scan.
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

const sessionAgentDir = path.join(
  repoRoot,
  "src-tauri",
  "src",
  "session",
  "agent",
);
const scanTargets = [
  path.join(repoRoot, "src", "shared", "frames.ts"),
  // Electron-era OmpProcess.ts/SessionAgent.ts/dialogs.ts are gone; the Rust files below cover them.
  path.join(repoRoot, "src-tauri", "src", "omp", "process.rs"),
  path.join(repoRoot, "src-tauri", "src", "omp", "transcript.rs"),
  // Read-only here: scanned for wire literals, never edited.
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
      // CVE-2024-27980: Windows can't spawn `.cmd` without a shell, and `shell: true` builds one
      // injectable command string. Run `cmd.exe` with separate argv elements instead (args are static).
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
      // Timeout so a stalled registry degrades this informational check to "unknown" instead of hanging CI.
      registryVersion = execFileSync(bin, args, { encoding: "utf8", timeout: 30_000 }).trim();
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
