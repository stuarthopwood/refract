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
// `isSupportedInvocation` below enforces this: any trailing text beyond the bare name or its one
// recognized subcommand is refused the same way an unknown command name is. Re-opening any of
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
 * working implementation today: just `/new` (`SessionAgent.startNewConversation`). Listed here,
 * not just handled in `chat.send`, so the menu shows it too (FR-032). */
export const NATIVE_BUILT_COMMANDS: readonly SlashCommandDescriptor[] = [
  { name: 'new', description: 'Start a new Conversation in this Session' },
];

/** Keeps only the subcommands this command actually has verified (`SUPPORTED_OMP_COMMANDS`);
 * an unverified subcommand (e.g. `todo`'s `copy`/`edit`/`import`/`export`/`drop`, `session`'s
 * `delete`/`pin`) is dropped here so neither the renderer menu nor `chat.send`'s validation
 * (which reads this same pruned list via `isSupportedInvocation`) can ever see it. */
function pruneSubcommands(command: SlashCommandDescriptor): SlashCommandDescriptor {
  if (!command.subcommands) return command;
  const allowed = SUPPORTED_OMP_COMMANDS[command.name] ?? [];
  return { ...command, subcommands: command.subcommands.filter((sub) => allowed.includes(sub.name)) };
}

/** Filters OMP's raw `available_commands_update` / `get_available_commands` list down to
 * `SUPPORTED_OMP_COMMANDS` (a command not listed is hidden, per FR-032), prunes each surviving
 * descriptor's `subcommands` to the verified set, then prepends Refract's own built native
 * commands so both show up in the same menu and the same `chat.send` validation
 * (`isSupportedInvocation` reads this same filtered-and-pruned list). */
export function filterSupportedCommands(commands: readonly SlashCommandDescriptor[]): SlashCommandDescriptor[] {
  return [
    ...NATIVE_BUILT_COMMANDS,
    ...commands
      .filter((command) => Object.prototype.hasOwnProperty.call(SUPPORTED_OMP_COMMANDS, command.name))
      .map(pruneSubcommands),
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

/** True when `commands` (already run through `filterSupportedCommands`, so subcommands are
 * pruned to the verified set) supports this EXACT invocation: the bare name, or the name plus
 * exactly one of its listed subcommands and nothing else. Every supported command was verified
 * in exactly one of those two shapes -- never with any further argument text -- so anything
 * else (an unverified subcommand of an allowed parent, or any trailing text after a valid bare
 * name or subcommand) is refused the same way an unrecognized command name is (Critical
 * remediation, issue #129). */
export function isSupportedInvocation(parsed: ParsedSlashCommand, commands: readonly SlashCommandDescriptor[]): boolean {
  const descriptor = commands.find((c) => c.name === parsed.name || (c.aliases ?? []).includes(parsed.name));
  if (!descriptor) return false;
  if (parsed.rest === '') return true;
  const spaceIdx = parsed.rest.indexOf(' ');
  const subName = spaceIdx === -1 ? parsed.rest : parsed.rest.slice(0, spaceIdx);
  const extra = spaceIdx === -1 ? '' : parsed.rest.slice(spaceIdx + 1).trim();
  if (extra !== '') return false;
  return (descriptor.subcommands ?? []).some((sub) => sub.name === subName);
}
