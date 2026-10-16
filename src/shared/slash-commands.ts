// The fixed, hand-maintained supported set for OMP's slash commands (T093, FR-032, FR-033):
// built from the probe table in docs/spike/FINDINGS.md item 23 (docs/spike/slash-commands-probe.mjs,
// re-run on omp 18.5.1; contracts/omp-usage.md "Slash command classification"). Only a command
// named here is ever shown in the menu (chat.commands / commands:update) or accepted by
// chat.send; every other OMP command -- the probe's denylisted/destructive/unverified names, and
// any command a later OMP patch adds -- stays hidden and is refused as unknown-command until a
// fresh probe run adds it here (FR-032: "A command that Refract has not verified on the
// supported OMP version MUST NOT be listed").
//
// Deliberately excluded despite completing cleanly in the 18.5.1 probe run:
// - 'switch' ("Switch model for this session only"): functionally a model write even though its
//   name does not match the probe's denylist regex; T092's own instructions flag "/model writes"
//   for Stuart's decision before Refract exposes them, and this is the same thing under a
//   different name. Needs an explicit decision, not silent inclusion.
// - 'ratchet', 'green', 'init' (the probe's starts-agent-turn class): each genuinely dispatches a
//   real idle agent turn. The isolated probe's unreachable fake model cannot confirm one
//   completes without getting stuck (FR-032: "run... without leaving the session stuck"); they
//   stay out until verified against a real, signed-in profile -- unchanged from the prior (now
//   superseded) run's same three names.
//
// Deliberately INCLUDED despite the probe's own DENYLIST regex naming it (never sent, so never
// verified by docs/spike/slash-commands-probe.mjs -- `contracts/omp-usage.md`'s "Slash command
// classification" table counts it in the 138-strong "needs-decision" bucket): 'advisor' (on,
// off, status). Issue #917, Decided (Stuart, 2026-10-16): the advisor subsystem is real and
// reachable in Refract today (a live blocker advisory arrived during the #558 live check,
// because the Refract-launched omp profile already carries `advisor.enabled: true`), but
// Refract had no in-app way to turn it on for a Session whose profile leaves it off, and no way
// to turn it off for one where it is on. Verified instead by issue #917's own live check against
// a real signed-in profile (a scratch Session running `/advisor off`, `/advisor status`,
// `/advisor on`, `/advisor status`, a real turn, then `/advisor off`) -- the same
// verified-before-listed bar FR-032 sets for a probe run, just run by hand once instead of
// through `slash-commands-probe.mjs` (`omp://advisor-watchdog.md` documents on/off/status among
// others -- `dump`, `dump raw` and `configure` stay refused, not in this allowlist; the live
// check instead confirms Refract's own forwarding path and that OMP's real `chat.commands`
// descriptor for a signed-in profile lists on/off/status). No Settings toggle. Decided (Stuart,
// 2026-10-16): no cost readout (`advisor_cost_changed` stays unread); `/advisor status` reports
// spend on demand instead; a persistent on/off indicator is tracked separately as issue #937.
//
// Critical remediation (issue #129, 2026-10-03): the allowlist used to be keyed on the
// command's top-level NAME ONLY, so an unverified SUBCOMMAND of an allowed parent -- one the
// probe explicitly denylisted and never ran, e.g. `/todo copy` (overwrites the real OS
// clipboard -- the probe's own header comment records this actually happened in an earlier
// run), `/todo edit`/`import` (opens $EDITOR / reads an arbitrary file), `/todo export`/`drop`,
// `/session delete` (deletes the current session), `/session pin` (pins the provider to a
// stored OAuth account), `/usage reset` (spends a saved rate-limit reset) -- still reached OMP
// under its allowed parent name. Every supported command below is now keyed on the EXACT
// verified shape: the bare name alone, or the name plus exactly one of its listed subcommand
// names. `contracts/omp-usage.md`'s per-command subcommand breakdown ("Slash command
// classification") is the only source for the subcommand lists below -- a name not listed there
// as works-local is not in the list, full stop.
//
// Free-form arguments (`/add-dir <path>`, `/rename [title]`, `/annotate`, `/autoresearch
// <goal>`, `/force <tool-name> [prompt]`, `/todo append/start/done/rm <fuzzy task>`, `/changelog
// last <N>`, ...): the probe only ever sent each command/subcommand as an exact, argument-free
// string (`/<name>` or `/<name> <subcommand>`), so no argument shape was ever observed running
// end to end. Decision (not yet re-probed with a signed-in profile): refuse arguments entirely
// for now rather than silently guess which are safe -- `/add-dir` in particular could widen the
// session's file-system access arbitrarily if any path were accepted unchecked.
// `classifySlashInvocation` below enforces this: any trailing text beyond the bare name or its
// one recognized subcommand is classified `'unsupported-arguments'`, a distinct refusal from an
// unrecognized command name. Re-opening any of
// these for real arguments needs a fresh probe run with a representative argument first
// (FR-032), not a quiet allowance here.

import type { SlashCommandDescriptor } from './frames';

/** Per-command subcommand names verified `works-local` bare (`contracts/omp-usage.md` "Slash
 * command classification"). The bare top-level name itself was always verified too (it is why
 * the name is a key here at all), so it is always allowed in addition to whatever this list
 * holds; an empty list just means "no subcommand was verified, bare only". A small, static,
 * string-keyed table, so a plain object, not a `Map`. */
export const SUPPORTED_OMP_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  fast: ['on', 'ultra', 'off', 'status'],
  slow: ['on', 'off', 'status'],
  'extended-context': ['on', 'off', 'status'],
  advisor: ['on', 'off', 'status'],
  prewalk: ['restart'],
  effort: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'],
  dump: ['all'],
  todo: ['expand', 'collapse', 'append', 'start', 'done', 'rm'],
  session: ['info'],
  jobs: ['full'],
  usage: ['show'],
  changelog: ['full', 'last'],
  tools: [],
  context: [],
  fresh: [],
  shake: ['elide', 'images', 'thinking'],
  retry: [],
  rename: [],
  'add-dir': [],
  dirs: [],
  force: [],
  autoresearch: [],
  annotate: [],
};

/** Refract's own native/reserved command names (constitution I: "Refract ... supplies natively
 * only the commands absent over RPC: /plan, /fork, /resume, /new, /settings, /pause,
 * /plan-review, and /btw."). Consolidated here as the one owner (previously duplicated as
 * `chat.ts`'s own `NATIVE_COMMANDS` map plus a separate hardcoded `commandName === 'new'`
 * branch) so a future OMP version adding a same-named real command (e.g. a real `/plan`) can
 * never be silently forwarded -- these names are refused locally even if OMP later offers them
 * too, the same way `chat.send`'s own doc comment already described. */
export const NATIVE_RESERVED_COMMANDS: Readonly<Record<string, true>> = {
  new: true,
  resume: true,
  plan: true,
  fork: true,
  settings: true,
  pause: true,
  'plan-review': true,
  btw: true,
};

/** Refract's own native commands (a subset of `NATIVE_RESERVED_COMMANDS`) that actually have a
 * working implementation today: `/new` (`SessionAgent.startNewConversation`) and `/btw` (spec
 * 014 FR-007: opens the Side chat panel and issues a `btw` request with the text after it).
 * Listed here, not just handled in `chat.send`, so the menu shows both (FR-032). */
export const NATIVE_BUILT_COMMANDS: readonly SlashCommandDescriptor[] = [
  { name: 'new', description: 'Start a new Conversation in this Session', source: 'native' },
  { name: 'btw', description: 'Ask the agent a side question', source: 'native' },
];

/** Issue #760 probe (FINDINGS item 57): OMP's own `source` field is `'builtin'` for its native
 * commands, `'file'` for a project/user command (OMP does not distinguish them further), and
 * `'skill'` for a `/skill:<name>` entry. A command whose `source` is anything other than one of
 * the two confirmed non-builtin values -- including a missing field entirely -- is treated as
 * builtin-restricted: fail closed towards the stricter, already-verified policy rather than
 * trusting an unprobed future `source` value with free-form arguments. Mirrors
 * `session::agent::commands.rs`'s own `is_builtin_source` (the Rust port of this same policy,
 * kept here too since Electron's `chat.ts` imports `filterSupportedCommands`/
 * `classifySlashInvocation` from this shared file unchanged). */
function isBuiltinSource(source: string | undefined): boolean {
  return source !== 'file' && source !== 'skill';
}

/** Keeps only the subcommands this command actually has verified (`SUPPORTED_OMP_COMMANDS`);
 * an unverified subcommand (e.g. `todo`'s `copy`/`edit`/`import`/`export`/`drop`, `session`'s
 * `delete`/`pin`) is dropped here so neither the renderer menu nor `chat.send`'s validation
 * (which reads this same pruned list via `classifySlashInvocation`) can ever see it. */
function pruneSubcommands(command: SlashCommandDescriptor): SlashCommandDescriptor {
  if (!command.subcommands) return command;
  const allowed = SUPPORTED_OMP_COMMANDS[command.name] ?? [];
  return { ...command, subcommands: command.subcommands.filter((sub) => allowed.includes(sub.name)) };
}

/** Filters OMP's raw `available_commands_update` / `get_available_commands` list down to
 * `SUPPORTED_OMP_COMMANDS` for builtin-sourced commands (hidden unless verified, per FR-032),
 * prunes each surviving descriptor's `subcommands` to the verified set, then prepends Refract's
 * own built native commands so both show up in the same menu and the same `chat.send`
 * validation. Issue #760: a raw command whose `source` is NOT builtin (a project/user `'file'`
 * command, or a `'skill'`) is listed exactly as OMP reports it, with no allowlist pruning -- the
 * user wrote it, so `SUPPORTED_OMP_COMMANDS` does not apply. Gate-fix (High, security): a
 * file/skill entry whose name or alias collides with ANY raw builtin-sourced entry -- allow-
 * listed or not -- is dropped entirely here, before the allow-list pruning below ever has a
 * chance to remove the builtin's own trace from the list a downstream shadow check might see. */
export function filterSupportedCommands(commands: readonly SlashCommandDescriptor[]): SlashCommandDescriptor[] {
  // Gate-fix: also seeded with `NATIVE_RESERVED_COMMANDS` -- a file/skill command named `plan`,
  // `resume`, etc. is refused unconditionally at `chat.send` regardless of source, so listing it
  // in the menu at all would be misleading (it can never actually run).
  const builtinClaimed = new Set<string>(Object.keys(NATIVE_RESERVED_COMMANDS));
  for (const command of commands) {
    if (!isBuiltinSource(command.source)) continue;
    builtinClaimed.add(command.name);
    for (const alias of command.aliases ?? []) builtinClaimed.add(alias);
  }
  return [
    ...NATIVE_BUILT_COMMANDS,
    ...commands.flatMap((command) => {
      if (!isBuiltinSource(command.source)) {
        const shadowsABuiltin =
          builtinClaimed.has(command.name) || (command.aliases ?? []).some((alias) => builtinClaimed.has(alias));
        return shadowsABuiltin ? [] : [command];
      }
      return Object.prototype.hasOwnProperty.call(SUPPORTED_OMP_COMMANDS, command.name)
        ? [pruneSubcommands(command)]
        : [];
    }),
  ];
}

/** The `/name` (and the raw remainder after it, trimmed) in a leading `/name ...`, or
 * `undefined` for ordinary text. `rest` is empty for a fully bare invocation. */
export interface ParsedSlashCommand {
  name: string;
  rest: string;
}

export function parseSlashCommand(text: string): ParsedSlashCommand | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return undefined;
  const body = trimmed.slice(1);
  const spaceIdx = body.search(/\s/);
  const name = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
  if (name === '') return undefined;
  const rest = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim();
  return { name, rest };
}

/** The three outcomes `chat.send` distinguishes for a slash invocation: `'supported'` runs it,
 * `'unknown-command'` is a name (or alias) `commands` never lists at all -- genuinely hidden per
 * FR-032 -- and `'unsupported-arguments'` is a LISTED, recognized command given a subcommand or
 * trailing text that was never verified (an unverified subcommand of an allowed parent, e.g.
 * `/todo copy`, or any argument text after a valid bare name/subcommand, e.g. `/rename foo`).
 * FR-033 reserves "unknown" for a command hidden under FR-032; a listed command whose only
 * unverified part is its arguments is a different, narrower refusal, so `chat.send` gives it a
 * distinct message instead of conflating it with "never heard of this command". */
export type SlashInvocationClassification = 'supported' | 'unknown-command' | 'unsupported-arguments';

function matchesName(descriptor: SlashCommandDescriptor, name: string): boolean {
  return descriptor.name === name || (descriptor.aliases ?? []).includes(name);
}

function classifyAgainstBuiltin(descriptor: SlashCommandDescriptor, rest: string): SlashInvocationClassification {
  const spaceIdx = rest.indexOf(' ');
  const subName = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const extra = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();
  if (extra !== '') return 'unsupported-arguments';
  return (descriptor.subcommands ?? []).some((sub) => sub.name === subName) ? 'supported' : 'unsupported-arguments';
}

/** Classifies `parsed` against `commands` (already run through `filterSupportedCommands`).
 * Issue #760: a non-builtin-sourced descriptor (project/user `'file'`, or `'skill'`) runs with
 * free-form arguments once its bare name is recognized; a builtin descriptor was verified in
 * exactly one of two shapes -- the bare name, or the name plus exactly one of its listed
 * subcommands, never with any further argument text -- so anything else on it is
 * `'unsupported-arguments'`, not `'unknown-command'` (Critical remediation, issue #129, refined
 * to distinguish the two refusal reasons). Gate-fix (High/Medium, security): a file/skill
 * command sharing a NAME OR ALIAS with a builtin must never inherit the free-form policy -- the
 * whole list is scanned for any builtin-sourced entry matching the name first, rather than
 * trusting whichever single descriptor the first `find` happens to pick. */
export function classifySlashInvocation(
  parsed: ParsedSlashCommand,
  commands: readonly SlashCommandDescriptor[]
): SlashInvocationClassification {
  const descriptor = commands.find((c) => matchesName(c, parsed.name));
  if (!descriptor) return 'unknown-command';
  if (parsed.rest === '') return 'supported';
  const shadowedBuiltin = commands.find((c) => matchesName(c, parsed.name) && isBuiltinSource(c.source));
  if (shadowedBuiltin) return classifyAgainstBuiltin(shadowedBuiltin, parsed.rest);
  if (!isBuiltinSource(descriptor.source)) return 'supported';
  return classifyAgainstBuiltin(descriptor, parsed.rest);
}
