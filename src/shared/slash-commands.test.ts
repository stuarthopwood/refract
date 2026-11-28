// #1812: Refract-native commands run without starting the agent; anything else must start it.
import { describe, it, expect } from 'vitest';
import type { SlashCommandDescriptor } from './frames';
import { classifySlashInvocation, filterSupportedCommands, isLocalNativeCommand, parseSlashCommand } from './slash-commands';

function local(text: string): boolean {
  const parsed = parseSlashCommand(text);
  return parsed !== undefined && isLocalNativeCommand(parsed);
}

describe('isLocalNativeCommand', () => {
  it('runs bare /new and /pause without the agent', () => {
    expect(local('/new')).toBe(true);
    expect(local('/pause')).toBe(true);
    expect(local('  /pause  ')).toBe(true);
  });

  it('runs /new <prompt> without the agent, since it starts its own Conversation (#1827)', () => {
    expect(local('/new fresh start')).toBe(true);
  });

  it('starts the agent when /pause carries arguments', () => {
    expect(local('/pause now')).toBe(false);
  });

  it('starts the agent for /role, bare or with a role', () => {
    expect(local('/role planner')).toBe(false);
    expect(local('/role   planner')).toBe(false);
    expect(local('/role')).toBe(false);
  });

  it('starts the agent for every other command', () => {
    expect(local('/compact')).toBe(false);
    expect(local('/btw what is this')).toBe(false);
  });

  it('is false for text that is not a slash command', () => {
    expect(local('new')).toBe(false);
    expect(local('/')).toBe(false);
  });
});

// #2088: OMP's `extension` and `custom` sources are non-builtin, like `file` and `skill`; unknown sources stay builtin.
describe('non-builtin slash command sources', () => {
  it.each(['file', 'skill', 'extension', 'custom'])('passes a %s command through unpruned', (source) => {
    const command: SlashCommandDescriptor = { name: 'skippy-banter', description: 'Trade insults', source };
    expect(filterSupportedCommands([command])).toContainEqual(command);
  });

  it('drops an unknown-source command that is not a verified builtin', () => {
    const command: SlashCommandDescriptor = { name: 'skippy-banter', description: 'x', source: 'mystery' };
    expect(filterSupportedCommands([command])).not.toContainEqual(command);
  });

  it('accepts free-form arguments on an extension command', () => {
    const commands: SlashCommandDescriptor[] = [{ name: 'skippy-banter', description: 'x', source: 'extension' }];
    const parsed = parseSlashCommand('/skippy-banter status');
    expect(parsed && classifySlashInvocation(parsed, commands)).toBe('supported');
  });

  it('refuses free-form arguments on an unknown-source command', () => {
    const commands: SlashCommandDescriptor[] = [{ name: 'mystery', description: 'x', source: 'mystery' }];
    const parsed = parseSlashCommand('/mystery anything');
    expect(parsed && classifySlashInvocation(parsed, commands)).toBe('unsupported-arguments');
  });
});
