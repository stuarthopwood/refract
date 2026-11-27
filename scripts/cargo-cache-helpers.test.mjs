import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runningCargoExecutables } from './cargo-cache-helpers.mjs';

describe('runningCargoExecutables', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cargo-cache-'));
  });
  afterEach(() => {
    // Only ever remove the mkdtemp dir created above; an empty path must never reach rmSync.
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    dir = '';
  });

  it('returns [] when debug/deps is missing', () => {
    expect(runningCargoExecutables(dir)).toEqual([]);
  });

  it('returns [] for an unlocked .exe and a non-.exe', () => {
    const deps = path.join(dir, 'debug', 'deps');
    mkdirSync(deps, { recursive: true });
    writeFileSync(path.join(deps, 'idle.exe'), 'x');
    writeFileSync(path.join(deps, 'lib.rlib'), 'x');
    expect(runningCargoExecutables(dir)).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('lists a running .exe but not a write-held non-.exe', async () => {
    const deps = path.join(dir, 'debug', 'deps');
    mkdirSync(deps, { recursive: true });
    const held = path.join(deps, 'held.exe');
    copyFileSync(process.execPath, held);
    const child = spawn(held, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    let fd;
    try {
      fd = openSync(path.join(deps, 'lib.rlib'), 'w');
      expect(runningCargoExecutables(dir)).toEqual([held]);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => {
          child.once('exit', resolve);
          child.once('error', resolve);
        });
        child.kill();
        await exited;
      }
    }
  });
});
