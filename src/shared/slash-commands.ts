
import type { SlashCommandDescriptor } from './frames';

/** Allowlist of OMP slash commands verified by probe; the bare name is always allowed, an empty list means bare only. */
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
  'forget-approvals': [],
};

/** Command names Refract handles natively; refused locally even if OMP later offers the same name. */
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

/** Listed here, not just handled in `chat.send`, so the menu shows both. */
export const NATIVE_BUILT_COMMANDS: readonly SlashCommandDescriptor[] = [
  { name: 'new', description: 'Start a new Conversation in this Session', source: 'native' },
  { name: 'btw', description: 'Ask the agent a side question', source: 'native' },
];

// OMP reports `source` as 'builtin', 'file' (project/user command) or 'skill' (#760).
function isBuiltinSource(source: string | undefined): boolean {
  return source !== 'file' && source !== 'skill';
}

// Drops unverified subcommands (e.g. `/todo copy`) so neither the menu nor `chat.send` can see them (#129).
function pruneSubcommands(command: SlashCommandDescriptor): SlashCommandDescriptor {
  if (!command.subcommands) return command;
  const allowed = SUPPORTED_OMP_COMMANDS[command.name] ?? [];
  return { ...command, subcommands: command.subcommands.filter((sub) => allowed.includes(sub.name)) };
}

/** Keeps verified builtin commands; non-builtin (user-written file or skill) commands pass through unpruned (#760). */
export function filterSupportedCommands(commands: readonly SlashCommandDescriptor[]): SlashCommandDescriptor[] {
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

/** The leading `/name` and its trimmed remainder. */
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
