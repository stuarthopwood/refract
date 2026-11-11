// #1812: Refract-native commands run without starting the agent; anything else must start it.
import { describe, it, expect } from 'vitest';
import { isLocalNativeCommand, parseSlashCommand } from './slash-commands';

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

  it('starts the agent when /new or /pause carry arguments', () => {
    expect(local('/new fresh start')).toBe(false);
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
