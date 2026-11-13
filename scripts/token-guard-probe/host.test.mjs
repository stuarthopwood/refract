import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildChildEnv } from './host.mjs';

const dirs = { agentDir: path.join('S', 'agent'), homeDir: path.join('S', 'home') };

describe('buildChildEnv', () => {
  it('never carries credentials from the parent env to the child', () => {
    const env = buildChildEnv({ PATH: 'p', OPENAI_API_KEY: 'sk-fake', GH_TOKEN: 'ghp_fake', DB_PASSWORD: 'hunter2' }, dirs);
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(['OPENAI_API_KEY']));
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.DB_PASSWORD).toBeUndefined();
    expect(Object.values(env)).not.toContain('sk-fake');
  });

  it('carries an allowlisted var under Windows `Path` casing', () => {
    const env = buildChildEnv({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows' }, dirs);
    expect(env.Path).toBe('C:\\bin');
    expect(env.SystemRoot).toBe('C:\\Windows');
  });

  it('lets scratch overrides win over parent values', () => {
    const env = buildChildEnv({ HOME: 'real', USERPROFILE: 'real', APPDATA: 'real', LOCALAPPDATA: 'real', PI_CODING_AGENT_DIR: 'real' }, dirs);
    expect(env.PI_CODING_AGENT_DIR).toBe(dirs.agentDir);
    expect(env.HOME).toBe(dirs.homeDir);
    expect(env.USERPROFILE).toBe(dirs.homeDir);
    expect(env.APPDATA).toBe(path.join(dirs.homeDir, 'AppData', 'Roaming'));
    expect(env.LOCALAPPDATA).toBe(path.join(dirs.homeDir, 'AppData', 'Local'));
  });
});
