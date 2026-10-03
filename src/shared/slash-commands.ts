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

import type { SlashCommandDescriptor } from './frames';

export const SUPPORTED_OMP_COMMANDS: ReadonlySet<string> = new Set([
  'fast',
  'slow',
  'extended-context',
  'prewalk',
  'effort',
  'dump',
  'todo',
  'session',
  'jobs',
  'usage',
  'changelog',
  'tools',
  'context',
  'fresh',
  'shake',
  'retry',
  'rename',
  'add-dir',
  'dirs',
  'force',
  'autoresearch',
  'annotate',
]);

/** Refract's own native commands (constitution I's reserved names, `src/main/ipc/chat.ts`
 * `NATIVE_COMMANDS`) that actually have a working implementation today: just `/new`
 * (`SessionAgent.startNewConversation`). Listed here, not just handled in `chat.send`, so the
 * menu shows it too (FR-032). */
export const NATIVE_BUILT_COMMANDS: readonly SlashCommandDescriptor[] = [
  { name: 'new', description: 'Start a new Conversation in this Session' },
];

/** Filters OMP's raw `available_commands_update` / `get_available_commands` list down to
 * `SUPPORTED_OMP_COMMANDS` (a command not in the set is hidden, per FR-032), then prepends
 * Refract's own built native commands so both show up in the same menu and the same
 * `chat.send` validation (`collectCommandNames` reads this same list). */
export function filterSupportedCommands(commands: readonly SlashCommandDescriptor[]): SlashCommandDescriptor[] {
  return [...NATIVE_BUILT_COMMANDS, ...commands.filter((command) => SUPPORTED_OMP_COMMANDS.has(command.name))];
}
