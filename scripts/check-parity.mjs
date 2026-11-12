#!/usr/bin/env node
// IPC parity report (ipc.ts vs Rust backend), re-derived each run so new channels show as missing.
// Usage: node scripts/check-parity.mjs [--markdown | --gate]  (--gate exits 1 if any channel is missing)

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchModAfterAttr } from './check-parity-helpers.mjs';

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


function extractConstObject(source, constName) {
  const match = source.match(new RegExp(`export const ${constName} = \\{([\\s\\S]*?)\\n\\} as const;?`));
  if (!match) throw new Error(`check-parity: could not find ${constName} in the IPC contract sources`);
  const entries = [];
  const entryRe = /^\s*([A-Z0-9_]+):\s*'([^']+)',?\s*$/gm;
  let m;
  while ((m = entryRe.exec(match[1]))) entries.push({ key: m[1], value: m[2] });
  // Guards against a line the regex silently failed to parse instead of undercounting channels.
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
// `ipc.ts` is at its line cap, so the Usage channels live in `ipc-usage.ts`.
const ipcUsageSource = readFile(path.join(repoRoot, 'src/shared/ipc-usage.ts'));
const requests = [
  ...extractConstObject(ipcSource, 'IPC_REQUESTS'),
  ...extractConstObject(ipcUsageSource, 'IPC_USAGE_REQUESTS'),
];
const events = [
  ...extractConstObject(ipcSource, 'IPC_EVENTS'),
  ...extractConstObject(ipcUsageSource, 'IPC_USAGE_EVENTS'),
];
const bootstrapMatch = ipcSource.match(/export const THEME_BOOTSTRAP_CHANNEL = '([^']+)';/);
if (!bootstrapMatch) throw new Error(`check-parity: could not find THEME_BOOTSTRAP_CHANNEL in ${relPath(ipcTsPath)}`);
const themeBootstrapChannel = bootstrapMatch[1];


function formatSources(set) {
  if (!set || set.size === 0) return 'unknown';
  return [...set].sort().join('; ');
}

// A naive split on the first `//` suffices: no `.register("...")` argument contains `//`.
function stripLineComments(content) {
  return content
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

// Blanks (not slices) `#[cfg(test)] mod` spans to keep offsets stable. Only gates a module when `mod \w+ {` follows
// the attribute, so an attribute on `fn`/`use` never blanks a later real module.
function stripCfgTestModules(content) {
  const attrRe = /#\[cfg\(test\)\]/g;
  let result = content;
  let m;
  while ((m = attrRe.exec(result))) {
    const afterAttr = m.index + m[0].length;
    const modMatch = matchModAfterAttr(result.slice(afterAttr));
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

// Comments and `#[cfg(test)]` modules are stripped first so neither inflates the registration count.
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

// `events.rs` declares a const per `IPC_EVENTS` entry but wires only some to a working emit path.
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

// An `emit_*` wrapper nothing calls is a declared-but-unsent event; `events.rs` is excluded since it only defines them.
function isEmitMethodCalledElsewhere(methodName) {
  const callRe = new RegExp(`\\.${methodName}\\(`);
  for (const file of walk(tauriSrcDir)) {
    if (!file.endsWith('.rs') || path.basename(file) === 'events.rs') continue;
    if (callRe.test(readFile(file))) return true;
  }
  return false;
}

// Lanes may call `.send`/`.emit` directly with the constant (optionally path-qualified) or its literal; the free
// `events::emit(&app, NAME, ...)` form takes the constant as its second argument.
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

// The one channel outside `IPC_EVENTS`/`IPC_REQUESTS`: implemented once `lib.rs` injects `window.__REFRACT_THEME_BOOTSTRAP__`.
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

// Lane ownership per docs/PLAN.md "Phase R"; scaffold channels no later lane claims stay with R1. Update when a lane's Files column changes.

const REQUEST_LANES = {
  READINESS_CHECK: 'R1', // #784, scaffold; no later lane claims readiness.rs
  READINESS_CHECK_STEP: 'R1', // same handler file as READINESS_CHECK
  REPOSITORIES_LIST: 'R2', // #785, store/registry.rs
  REPOSITORIES_ADD: 'R2',
  REPOSITORIES_REMOVE: 'R2',
  REPOSITORIES_RENAME: 'R2',
  REPOSITORIES_SET_COLOR: 'R2', // #887, ipc/repositories_color.rs
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
  SESSIONS_DELETING: 'R2',
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
  CLIPBOARD_READ_TEXT: 'R1',
  CLIPBOARD_WRITE_IMAGE: 'R1',
  CLIPBOARD_SAVE_IMAGE: 'R1',
  SPELLCHECK_SUGGEST: 'R1',
  SPELLCHECK_ADD: 'R1',
  CONVERSATIONS_LIST: 'R1', // scaffold; conversations.rs not reassigned
  CONVERSATIONS_START_NEW: 'R1',
  CONVERSATIONS_OPEN: 'R1',
  CHAT_SEND: 'R4', // #787, ipc/chat.rs (chat send path)
  CHAT_STOP: 'R4',
  CHAT_REMOVE_QUEUED: 'R4',
  CHAT_SEND_NOW: 'R4',
  CHAT_PAUSE: 'R4', // #477, ipc/chat_pause.rs
  CHAT_RESUME: 'R4',
  CHAT_PAUSE_ALL: 'R4',
  CHAT_RESUME_ALL: 'R4',
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
  WINDOW_ZOOM: 'R8', // #825, shell/zoom.rs
  PULL_REQUESTS_LIST: 'R9', // #792, ipc/pull_requests.rs
  HOME_LAST_MESSAGES: 'R9', // #869, ipc/home.rs
  HOME_CLOSED_BRANCHES: 'R9', // #869, ipc/home.rs
  PULL_REQUESTS_LIST_ACROSS: 'R9', // #874, ipc/pull_requests/extra_handlers/list_across.rs
  PULL_REQUESTS_DETAIL: 'R9',
  PULL_REQUESTS_COMMENT: 'R9',
  PULL_REQUESTS_REPLY_TO_THREAD: 'R9',
  PULL_REQUESTS_RESOLVE_THREAD: 'R9',
  PULL_REQUESTS_UNRESOLVE_THREAD: 'R9',
  PULL_REQUESTS_SUBMIT_REVIEW: 'R9',
  PULL_REQUESTS_MERGE: 'R9',
  PULL_REQUESTS_CLOSE: 'R9',
  ISSUES_LABELS: 'R9', // #503, ipc/issues.rs
  ISSUES_SEARCH: 'R9',
  ISSUES_CREATE: 'R9',
  ISSUES_LIST: 'R9', // #504, ipc/issues.rs
  ISSUES_VIEW: 'R9',
  PULL_REQUESTS_FETCH_IMAGE: 'R9',
  PULL_REQUESTS_NEW_SESSION_FROM_PULL_REQUEST: 'R9',
  THEME_SET: 'R8', // #791, theme.rs
  THEME_SET_CUSTOM: 'R8', // #458, themes.rs
  THEMES_LIST: 'R8',
  THEMES_IMPORT: 'R8',
  THEMES_EXPORT: 'R8',
  THEMES_REMOVE: 'R8',
  THEMES_OPEN_FOLDER: 'R8',
  TOKEN_GUARD_GET: 'TG',
  TOKEN_GUARD_SET: 'TG',
  TOKEN_GUARD_RESET: 'TG',
  TOKEN_GUARD_RESET_ALL: 'TG',
  TOKEN_GUARD_DISMISS_THRESHOLDS_RESET: 'TG',
  TOKEN_GUARD_HANDOFF: 'TG',
  ADVISOR_ROSTER_DETECT: 'TG', // #1409, ipc/advisor_roster.rs
  ADVISOR_ROSTER_OPEN: 'TG',
  COPILOT_PLAN_USAGE: 'R9', // #1238, ipc/copilot_plan.rs
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
  WORKING_MODE_SET: 'AU', // #433, ipc/working_mode.rs
  USAGE_START: 'U', // #1331, ipc/usage.rs and ipc/usage_prefs.rs
  USAGE_STATUS: 'U',
  USAGE_SUMMARY: 'U',
  USAGE_TIMESERIES: 'U',
  USAGE_TOKEN_MIX: 'U',
  USAGE_BREAKDOWN: 'U',
  USAGE_TOP_SESSIONS: 'U',
  USAGE_CALLS: 'U',
  USAGE_FRUSTRATION: 'U',
  USAGE_BUDGET: 'U',
  USAGE_GET_PREFS: 'U',
  USAGE_SET_PREFS: 'U',
};

const EVENT_LANES = {
  SESSION_STATUS: 'R3', // #786, agent start/stop state machine
  SESSION_LIST_CHANGED: 'R2', // #785, session lifecycle
  SESSION_DELETED: 'R2', // #1591, background delete finished
  SESSION_DELETE_FAILED: 'R2', // #1591, background delete failed
  TRANSCRIPT_PATCH: 'R4', // #787, chat send path streaming
  QUEUE_UPDATE: 'R4', // "queue identity #540" in R4's own work description
  REQUEST_PENDING: 'R4',
  REQUEST_RESOLVED: 'R4',
  COMMANDS_UPDATE: 'R4',
  SETTINGS_CHANGED: 'R8', // #791
  UI_OPEN_SESSION: 'R10b', // #793, window shell/chrome
  MEMORY_WARNING: 'R5', // #788, "memory warning" in R5's own work description
  TOKEN_GUARD_LAUNCH_WARNING: 'TG', // #1212, token guard launch warning
  TOKEN_GUARD_CALLS: 'TG', // #1212, per-Conversation model-call count
  ADVISOR_ROSTER_DETECTED: 'TG', // #1409, roster found at Session launch
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
  GITHUB_CHANGED: 'R9', // #1589, list refresh after a merge, close or Session write
  USAGE_PROGRESS: 'U', // #1331
};

const THEME_BOOTSTRAP_LANE = 'R8'; // #791, theme.rs


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
