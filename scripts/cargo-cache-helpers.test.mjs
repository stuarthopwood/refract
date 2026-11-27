import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runningCargoExecutables } from './cargo-cache-helpers.mjs';

describe('runningCargoExecutables', () => {
  let dir = '';
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] when debug/deps is missing', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cargo-cache-'));
    expect(runningCargoExecutables(dir)).toEqual([]);
  });

  it('returns [] for an unlocked .exe and a non-.exe', () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cargo-cache-'));
    const deps = path.join(dir, 'debug', 'deps');
    mkdirSync(deps, { recursive: true });
    writeFileSync(path.join(deps, 'idle.exe'), 'x');
    writeFileSync(path.join(deps, 'lib.rlib'), 'x');
    expect(runningCargoExecutables(dir)).toEqual([]);
  });
});
