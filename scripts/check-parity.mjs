#!/usr/bin/env node
// Issue #784 (Phase R, docs/PLAN.md R1): generated parity report for the renderer-facing IPC
// contract (`src/shared/ipc.ts`'s `IPC_REQUESTS`, `IPC_EVENTS`, `THEME_BOOTSTRAP_CHANNEL`)
// against the Rust (Tauri, `src-tauri/src`) backend, alongside the Phase R lane that owns it.
// Replaces the hand-kept `specs/016-tauri-rust-build/parity.md` table, which could silently
// drift from the real channel list -- this script re-derives everything from source on every
// run, so a channel added to `ipc.ts` later shows up as missing automatically, with no table to
// remember to update.
//
// The Electron source-file column this report used to carry (`src/main`'s own
// `ipcMain.handle`/`ipcMain.on` call sites) was removed at #796/R13: Electron was deleted, so
// there is no longer an Electron side to cite. Rust implementation state is now the only thing
// this script checks.
//
// Usage:
//   node scripts/check-parity.mjs              print a plain-text table + totals
//   node scripts/check-parity.mjs --markdown    print a GitHub-flavoured markdown table instead
//   node scripts/check-parity.mjs --gate        exit 1 if any channel is not implemented (the
//                                                parity gate, switched on in CI at #796/R13)
// Exits 0 otherwise, even when channels are missing (report-only without `--gate`).

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const ipcTsPath = path.join(repoRoot, 'src/shared/ipc.ts');
const tauriSrcDir = path.join(repoRoot, 'src-tauri/src');

const args = process.argv.slice(2);
const markdown = args.includes('--markdown');
const gate = args.includes('--gate');

function readFile(p) {
  return readFileSync(p, 'utf-8');
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function relPath(p) {
  return path.relative(repoRoot, p).replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// 1. The contract: IPC_REQUESTS / IPC_EVENTS / THEME_BOOTSTRAP_CHANNEL from ipc.ts. Read, not
// copied, so this never drifts from the real channel list (FR-008 in spec 016).
// ---------------------------------------------------------------------------

function extractConstObject(source, constName) {
  const match = source.match(new RegExp(`export const ${constName} = \\{([\\s\\S]*?)\\n\\} as const;`));
  if (!match) throw new Error(`check-parity: could not find ${constName} in ${relPath(ipcTsPath)}`);
  const entries = [];
  const entryRe = /^\s*([A-Z0-9_]+):\s*'([^']+)',?\s*$/gm;
  let m;
  while ((m = entryRe.exec(match[1]))) entries.push({ key: m[1], value: m[2] });
  // Guards against a line the regex above silently failed to parse (a trailing `// comment`, a
  // different quote style, ...) instead of quietly undercounting the real channel list.
  const bodyLineCount = match[1]
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith('//')).length;
  if (bodyLineCount !== entries.length) {
    throw new Error(
      `check-parity: ${constName} entry count mismatch -- parsed ${entries.length} entries but found ${bodyLineCount} non-comment line(s) in its object body`,
    );
  }
  return entries;
}

const ipcSource = readFile(ipcTsPath);
const requests = extractConstObject(ipcSource, 'IPC_REQUESTS');
const events = extractConstObject(ipcSource, 'IPC_EVENTS');
const bootstrapMatch = ipcSource.match(/export const THEME_BOOTSTRAP_CHANNEL = '([^']+)';/);
if (!bootstrapMatch) throw new Error(`check-parity: could not find THEME_BOOTSTRAP_CHANNEL in ${relPath(ipcTsPath)}`);
const themeBootstrapChannel = bootstrapMatch[1];

// ---------------------------------------------------------------------------
// 2. Rust implementation state, scanned recursively under `src-tauri/src` so it never depends on
// which file a `register(...)` call currently lives in (lanes are splitting `ipc/mod.rs` and
// `session/agent.rs` into per-lane modules while this runs).
// ---------------------------------------------------------------------------

function formatSources(set) {
  if (!set || set.size === 0) return 'unknown';
  return [...set].sort().join('; ');
}

/** Strips a trailing `//` line comment from each line before scanning for `.register(...)` calls
 * (this codebase's `.register("...")` calls never put a `//` inside the string argument, so a
 * naive per-line split on the first `//` is sufficient to keep a commented-out call from being
 * counted as a real registration). */
function stripLineComments(content) {
  return content
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/** Blanks out every `#[cfg(test)] mod ... { ... }` span (brace-depth matched from the `{` that
 * follows `mod`) so a test-only registration never inflates the count. Blanking rather than
 * slicing keeps every other line's offset -- and the rest of this scan -- unaffected. Only
 * treats a `#[cfg(test)]` attribute as gating a module if `mod \w+ {` is the next real token
 * after it (only whitespace and `//` line comments may sit between); an attribute annotating
 * anything else (`fn`, `use`, ...) is left untouched so a later, unrelated real module is never
 * walked past and blanked out by mistake. */
function stripCfgTestModules(content) {
  const attrRe = /#\[cfg\(test\)\]/g;
  let result = content;
  let m;
  while ((m = attrRe.exec(result))) {
    const afterAttr = m.index + m[0].length;
    const modMatch = /^(?:\s|\/\/[^\n]*)*mod\s+\w+\s*\{/.exec(result.slice(afterAttr));
    if (!modMatch) {
      attrRe.lastIndex = afterAttr;
      continue;
    }
    const braceStart = afterAttr + modMatch[0].length - 1;
    let depth = 1;
    let i = braceStart + 1;
    while (i < result.length && depth > 0) {
      if (result[i] === '{') depth += 1;
      else if (result[i] === '}') depth -= 1;
      i += 1;
    }
    const span = result.slice(m.index, i);
    result = result.slice(0, m.index) + span.replace(/[^\n]/g, ' ') + result.slice(i);
    attrRe.lastIndex = i;
  }
  return result;
}

/** Every string literal passed as the first argument to a `.register(...)` call, anywhere under
 * `src-tauri/src` -- the Rust `Dispatcher`'s channel registration. Comments and `#[cfg(test)]`
 * modules are stripped first so neither a commented-out call nor a test-only registration
 * counts. */
function findRustRegisteredRequests() {
  const registered = new Set();
  const registeredSources = new Map(); // registered string -> Set<relative file path>
  let rawCount = 0;
  for (const file of walk(tauriSrcDir)) {
    if (!file.endsWith('.rs')) continue;
    const content = stripCfgTestModules(stripLineComments(readFile(file)));
    const re = /\.register\(\s*"([a-zA-Z0-9_.]+)"/g;
    let m;
    while ((m = re.exec(content))) {
      registered.add(m[1]);
      rawCount += 1;
      if (!registeredSources.has(m[1])) registeredSources.set(m[1], new Set());
      registeredSources.get(m[1]).add(relPath(file));
    }
  }
  return { registered, registeredSources, rawCount };
}

/** `events.rs` declares one `pub const NAME: &str = "value"` per `IPC_EVENTS` entry (FR-008
 * comment at the top of that file) but only wires some of them to a working emit path. Returns
 * the constant -> string-value map plus the constant -> emit-method-name map for constants whose
 * `emit_*` wrapper in this file sends them via `self.send(NAME, ...)` (used by
 * `isEmitMethodCalledElsewhere` below for the pre-split scaffold's own call path). */
function findRustEventConstants() {
  const eventsRsPath = path.join(tauriSrcDir, 'events.rs');
  const content = readFile(eventsRsPath);
  const constants = new Map(); // constName -> string value
  const constRe = /pub const ([A-Z0-9_]+): &str = "([^"]+)";/g;
  let m;
  while ((m = constRe.exec(content))) constants.set(m[1], m[2]);

  const emitMethodByConst = new Map(); // constName -> emit_* method name
  const methodRe = /pub fn (emit_\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n    \}/g;
  while ((m = methodRe.exec(content))) {
    const [, methodName, body] = m;
    const sendMatch = body.match(/self\.send\(\s*([A-Z0-9_]+)\s*,/);
    if (sendMatch) emitMethodByConst.set(sendMatch[1], methodName);
  }
  return { constants, emitMethodByConst };
}

/** An `emit_*` wrapper that exists but is never called anywhere is the Rust equivalent of a
 * declared-but-unsent event: `self.send(...)` would run, but nothing ever reaches it. Checked
 * against every `.rs` file except `events.rs` itself (which only ever defines these methods, not
 * calls them). */
function isEmitMethodCalledElsewhere(methodName) {
  const callRe = new RegExp(`\\.${methodName}\\(`);
  for (const file of walk(tauriSrcDir)) {
    if (!file.endsWith('.rs') || path.basename(file) === 'events.rs') continue;
    if (callRe.test(readFile(file))) return true;
  }
  return false;
}

/** A lane calling its own event directly -- `.send(NAME, ...)`/`.emit(NAME, ...)` with the named
 * constant (optionally path-qualified, e.g. `crate::events::NAME` or `events::emit(&app, NAME,
 * ...)`'s free-function form, which takes the constant as its *second* argument rather than
 * calling it as a method), or `.send("value", ...)`/`.emit("value", ...)` with the constant's own
 * string literal -- now that `EventSink::send` is `pub(crate)` (issue #784: no `events.rs` edit
 * required to add a new emit call). Line comments are stripped first so a commented-out call is
 * never counted. Checked against every `.rs` file except `events.rs` itself, which only defines
 * the constants, the `emit_*` wrappers, and the free `emit()` function, never calls them
 * directly. */
function isEventSentDirectlyFromLaneFile(constName, value) {
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const methodCallRe = new RegExp(`\\.(?:send|emit)\\(\\s*(?:(?:[\\w:]+::)?${constName}\\b|"${escapedValue}")`);
  const freeEmitRe = new RegExp(`\\bemit\\(\\s*[^,]+,\\s*(?:[\\w:]+::)?${constName}\\b`);
  for (const file of walk(tauriSrcDir)) {
    if (!file.endsWith('.rs') || path.basename(file) === 'events.rs') continue;
    const content = stripLineComments(readFile(file));
    if (methodCallRe.test(content) || freeEmitRe.test(content)) return true;
  }
  return false;
}

/** FR-010/FR-011 (spec 016): the one non-`IPC_EVENTS`/non-`IPC_REQUESTS` channel. Implemented
 * once `lib.rs` injects `window.__REFRACT_THEME_BOOTSTRAP__` via a Tauri `initialization_script`. */
function isThemeBootstrapImplemented() {
  for (const file of walk(tauriSrcDir)) {
    if (!file.endsWith('.rs')) continue;
    const content = readFile(file);
    if (content.includes('.initialization_script(') && content.includes('__REFRACT_THEME_BOOTSTRAP__')) {
      return true;
    }
  }
  return false;
}

const {
  registered: rustRegisteredRequests,
  registeredSources: rustRegisteredSources,
  rawCount: rustRegisterRawCount,
} = findRustRegisteredRequests();
const { constants: rustEventConstants, emitMethodByConst } = findRustEventConstants();
const rustSentEventConsts = new Set(
  [...rustEventConstants.entries()]
    .filter(([constName, value]) => {
      const methodName = emitMethodByConst.get(constName);
      return (methodName && isEmitMethodCalledElsewhere(methodName)) || isEventSentDirectlyFromLaneFile(constName, value);
    })
    .map(([constName]) => constName),
);
const themeBootstrapImplemented = isThemeBootstrapImplemented();

// A registered string with no matching `IPC_REQUESTS` entry is a typo'd or stale channel name --
// report it (and, under `--gate`, fail on it) instead of letting it silently vanish.
const ipcRequestValues = new Set(requests.map((r) => r.value));
const unexpectedRegistrations = [...rustRegisteredRequests]
  .filter((value) => !ipcRequestValues.has(value))
  .map((value) => ({ value, sources: formatSources(rustRegisteredSources.get(value)) }));

function rustEventConstNameForValue(value) {
  for (const [constName, constValue] of rustEventConstants) {
    if (constValue === value) return constName;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. Lane ownership, derived from docs/PLAN.md "Phase R: Rust promotion" (the `#`/`Issue`/`Files
// touched` columns, read 2026-10-13). Each lane's own `.rs` file(s) and work description decide
// which channels it owns; channels already implemented in the pre-split scaffold with no later
// lane claiming their file (clipboard, conversations, readiness, the core session list/create)
// stay attributed to R1 (#784, this issue). Update this map when a Phase R row's Files column
// changes.
// ---------------------------------------------------------------------------

const REQUEST_LANES = {
  READINESS_CHECK: 'R1', // #784, scaffold; no later lane claims readiness.rs
  REPOSITORIES_LIST: 'R2', // #785, store/registry.rs
  REPOSITORIES_ADD: 'R2',
  REPOSITORIES_REMOVE: 'R2',
  REPOSITORIES_RENAME: 'R2',
  REPOSITORIES_BRANCHES: 'R2',
  REPOSITORIES_REMOTES: 'R2', // explicitly named in R2's work description
  REPOSITORIES_PICK_FOLDER: 'R2',
  REPOSITORIES_USER_NAME: 'R2',
  SESSIONS_LIST: 'R2', // ipc/sessions_lifecycle.rs
  SESSIONS_CREATE: 'R2',
  SESSIONS_RENAME: 'R2',
  SESSIONS_OPEN: 'R3', // #786, ipc/sessions_agent.rs (start control)
  SESSIONS_ARCHIVE: 'R2',
  SESSIONS_RESTORE: 'R2',
  SESSIONS_DELETE_CHECK: 'R2',
  SESSIONS_DELETE: 'R2',
  SESSIONS_RECREATE_WORKTREE: 'R2',
  SESSIONS_RECOVER: 'R3',
  SESSIONS_RESUME: 'R3',
  SESSIONS_STOP_AGENT: 'R3',
  SESSIONS_KEEP_WAITING_FOR_START: 'R3',
  SESSIONS_CANCEL_START: 'R3',
  SESSIONS_SET_VISIBLE: 'R3',
  SESSIONS_DIFF_STAT: 'R2',
  SESSIONS_REVEAL_WORKTREE: 'R2',
  SESSIONS_REVEAL_FILE: 'R7', // #790, ipc/files.rs (file security, not session lifecycle)
  ATTACHMENTS_READ_IMAGE_FILE: 'R4', // #787, ipc/attachments.rs
  CLIPBOARD_WRITE_TEXT: 'R1', // scaffold; clipboard.rs not reassigned to a later lane
  CONVERSATIONS_LIST: 'R1', // scaffold; conversations.rs not reassigned
  CONVERSATIONS_START_NEW: 'R1',
  CONVERSATIONS_OPEN: 'R1',
  CHAT_SEND: 'R4', // #787, ipc/chat.rs (chat send path)
  CHAT_STOP: 'R4',
  CHAT_REMOVE_QUEUED: 'R4',
  CHAT_SEND_NOW: 'R4',
  CHAT_ANSWER: 'R4',
  CHAT_COMMANDS: 'R4',
  CHAT_PREDICT_WORD: 'R6', // #789, word prediction is R6's work, despite chat.ts housing it
  CHAT_PREDICT_WORD_FEEDBACK: 'R6',
  CHAT_SET_VISIBLE_SUBAGENT: 'R5', // #788, subagents own setVisibleSubagent/subagentSnapshot despite chat.ts housing them
  CHAT_SUBAGENT_SNAPSHOT: 'R5',
  SIDE_CHAT_ASK: 'R6', // #789, ipc/side_chat.rs
  SIDE_CHAT_CANCEL: 'R6',
  SIDE_CHAT_GET_HISTORY: 'R6',
  FILE_EXPLORER_LIST_DIRECTORY: 'R7', // #790, ipc/file_explorer.rs
  FILE_EXPLORER_READ_PREVIEW: 'R7',
  FILE_EXPLORER_GET_STATUS: 'R7',
  FILE_EXPLORER_OPEN_IN_VSCODE: 'R7',
  FILE_EXPLORER_REVEAL: 'R7',
  FILE_EXPLORER_COPY_PATH: 'R7',
  FILE_EXPLORER_STOP_WATCHING: 'R7',
  FILE_EXPLORER_ENSURE_WATCHING: 'R7',
  SETTINGS_GET: 'R8', // #791, ipc/settings.rs
  SETTINGS_SET_APPROVAL_MODE: 'R8',
  SETTINGS_SET_READOUT_VISIBILITY: 'R8',
  SETTINGS_SET_SPLIT: 'R8',
  SETTINGS_SET_WATERMARK_ENABLED: 'R8',
  SETTINGS_SET_TRANSCRIPT_DISPLAY: 'R8',
  SETTINGS_SET_SHOW_SAMPLE_DATA: 'R8',
  SETTINGS_SET_DETECT_IMAGE_PATHS_ON_PASTE: 'R8',
  SETTINGS_SET_WORD_PREDICTION_ENABLED: 'R6', // #772's off switch, registered in ipc/settings.rs
  SETTINGS_SET_SESSION_LIST_COLLAPSE: 'R8', // #735, registered in ipc/settings.rs
  MODEL_ROLES_LIST: 'R8', // #791, "model roles" in R8's own work description
  MODEL_ROLES_SET: 'R8',
  MODEL_ROLES_LIST_CATALOG: 'R8',
  WINDOW_POPUP_MENU: 'R8', // #791, shell/menu.rs ("native menu")
  PULL_REQUESTS_LIST: 'R9', // #792, ipc/pull_requests.rs
  PULL_REQUESTS_DETAIL: 'R9',
  PULL_REQUESTS_COMMENT: 'R9',
  PULL_REQUESTS_REPLY_TO_THREAD: 'R9',
  PULL_REQUESTS_RESOLVE_THREAD: 'R9',
  PULL_REQUESTS_UNRESOLVE_THREAD: 'R9',
  PULL_REQUESTS_SUBMIT_REVIEW: 'R9',
  PULL_REQUESTS_MERGE: 'R9',
  PULL_REQUESTS_NEW_SESSION_FROM_PULL_REQUEST: 'R9',
  THEME_PREVIEW: 'R8', // #791, theme.rs
  THEME_SET: 'R8',
  TOKEN_GUARD_GET: 'TG',
  TOKEN_GUARD_SET: 'TG',
  TOKEN_GUARD_RESET: 'TG',
  ACCOUNTS_GITHUB_LIST: 'R9', // #792, accounts.rs
  ACCOUNTS_GITHUB_ADD_START: 'R9',
  ACCOUNTS_GITHUB_ADD_CANCEL: 'R9',
  ACCOUNTS_GITHUB_SWITCH: 'R9',
  ACCOUNTS_GITHUB_SIGN_OUT: 'R9',
  ACCOUNTS_OMP_LIST: 'R9',
  ACCOUNTS_OMP_SIGN_IN: 'R9',
  ACCOUNTS_OMP_SIGN_OUT: 'R9',
  ACCOUNTS_OMP_ANSWER: 'R9',
  APP_OPEN_RELEASE_NOTES: 'R9', // "release notes" in R9's own work description
  MODEL_SET_MODEL: 'RM', // #454/#740/#741/#762/#766/#760, ipc/model.rs
  MODEL_CYCLE_MODEL: 'RM',
  MODEL_APPLY_ROLE: 'RM',
  MODEL_LIST_ROLES: 'RM',
  MODEL_SET_THINKING_LEVEL: 'RM', // #564, ipc/model.rs
};

const EVENT_LANES = {
  SESSION_STATUS: 'R3', // #786, agent start/stop state machine
  SESSION_LIST_CHANGED: 'R2', // #785, session lifecycle
  TRANSCRIPT_PATCH: 'R4', // #787, chat send path streaming
  QUEUE_UPDATE: 'R4', // "queue identity #540" in R4's own work description
  REQUEST_PENDING: 'R4',
  REQUEST_RESOLVED: 'R4',
  COMMANDS_UPDATE: 'R4',
  SETTINGS_CHANGED: 'R8', // #791
  UI_OPEN_SESSION: 'R10b', // #793, window shell/chrome
  MEMORY_WARNING: 'R5', // #788, "memory warning" in R5's own work description
  TOKEN_GUARD_LAUNCH_WARNING: 'TG', // #1212, token guard launch warning
  READOUT_UPDATE: 'R5',
  SUBAGENTS_UPDATE: 'R5',
  SUBAGENT_PATCH: 'R5',
  SIDE_CHAT_PATCH: 'R6', // #789
  SIDE_CHAT_INTERRUPTED: 'R6',
  SIDE_CHAT_CONVERSATION_CHANGED: 'R6',
  FILE_EXPLORER_PATCH: 'R7', // #790
  FILE_EXPLORER_RESET: 'R7',
  ACCOUNTS_GITHUB_CHANGED: 'R9', // #792
  ACCOUNTS_GITHUB_ADD_PROGRESS: 'R9',
};

const THEME_BOOTSTRAP_LANE = 'R8'; // #791, theme.rs

// ---------------------------------------------------------------------------
// 4. Build the report rows.
// ---------------------------------------------------------------------------

const rows = [];

for (const { key, value } of requests) {
  rows.push({
    channel: value,
    kind: 'request',
    lane: REQUEST_LANES[key] ?? 'unassigned',
    implemented: rustRegisteredRequests.has(value),
  });
}

for (const { key, value } of events) {
  const constName = rustEventConstNameForValue(value);
  rows.push({
    channel: value,
    kind: 'event',
    lane: EVENT_LANES[key] ?? 'unassigned',
    implemented: constName !== null && rustSentEventConsts.has(constName),
  });
}

rows.push({
  channel: themeBootstrapChannel,
  kind: 'bootstrap',
  lane: THEME_BOOTSTRAP_LANE,
  implemented: themeBootstrapImplemented,
});

const requestRows = rows.filter((r) => r.kind === 'request');
const eventRows = rows.filter((r) => r.kind === 'event');
const bootstrapRow = rows.find((r) => r.kind === 'bootstrap');

// ---------------------------------------------------------------------------
// 5. Print.
// ---------------------------------------------------------------------------

function printMarkdownTable(tableRows) {
  console.log('| Channel | Kind | Lane | Implemented |');
  console.log('|---|---|---|---|');
  for (const r of tableRows) {
    console.log(`| \`${r.channel}\` | ${r.kind} | ${r.lane} | ${r.implemented ? 'yes' : 'no'} |`);
  }
}

function printPlainTable(tableRows) {
  const header = ['Channel', 'Kind', 'Lane', 'Implemented'];
  const columns = ['channel', 'kind', 'lane'];
  const widths = columns.map((col, i) => Math.max(header[i].length, ...tableRows.map((r) => r[col].length)) + 2);
  console.log(columns.map((col, i) => header[i].padEnd(widths[i])).join('') + header[3]);
  for (const r of tableRows) {
    console.log(columns.map((col, i) => String(r[col]).padEnd(widths[i])).join('') + (r.implemented ? 'yes' : 'no'));
  }
}

if (markdown) {
  console.log('## Requests\n');
  printMarkdownTable(requestRows);
  console.log('\n## Events\n');
  printMarkdownTable(eventRows);
  console.log('\n## Bootstrap\n');
  printMarkdownTable([bootstrapRow]);
  console.log();
} else {
  printPlainTable(rows);
  console.log();
}

for (const { value, sources } of unexpectedRegistrations) {
  console.log(`unexpected registration: "${value}" (${sources}) -- not in IPC_REQUESTS`);
}

const requestsDone = requestRows.filter((r) => r.implemented).length;
const eventsDone = eventRows.filter((r) => r.implemented).length;

console.log(`requests: ${requestsDone} of ${requestRows.length}`);
console.log(`events: ${eventsDone} of ${eventRows.length}`);
console.log(`theme bootstrap: ${bootstrapRow.implemented ? 'done' : 'todo'}`);
console.log(`(${rustRegisterRawCount} total .register(...) call(s) across src-tauri/src resolve to ${requestsDone} unique registered request channel(s))`);

const missing =
  requestRows.filter((r) => !r.implemented).length +
  eventRows.filter((r) => !r.implemented).length +
  (bootstrapRow.implemented ? 0 : 1) +
  unexpectedRegistrations.length;

if (gate && missing > 0) {
  console.log(`check:parity --gate: ${missing} channel(s) missing`);
  process.exit(1);
}
process.exit(0);
