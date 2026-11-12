import { describe, expect, it } from 'vitest';
import { extractChangelogSection } from './release-changelog.mjs';

const LOG = ['# Changelog', '', '## v1.2.30 (2026-02-01)', '', '- thirty', '', '## v1.2.3 (2026-01-01)', '', '- three', '', '## v1.2.2 (2025-12-01)', '', '- two', ''].join('\n');

describe('extractChangelogSection', () => {
  it('returns the exact section up to the next version heading', () => {
    expect(extractChangelogSection(LOG, '1.2.3')).toBe('## v1.2.3 (2026-01-01)\n\n- three\n');
  });

  it('does not confuse 1.2.3 with 1.2.30', () => {
    expect(extractChangelogSection(LOG, '1.2.30')).toBe('## v1.2.30 (2026-02-01)\n\n- thirty\n');
  });

  it('does not treat dots as wildcards', () => {
    expect(extractChangelogSection('## v1x2x3 (2026-01-01)\n', '1.2.3')).toBeNull();
  });

  it('handles CRLF input', () => {
    expect(extractChangelogSection(LOG.replace(/\n/g, '\r\n'), '1.2.3')).toBe('## v1.2.3 (2026-01-01)\n\n- three\n');
  });

  it('returns null when the version is absent', () => {
    expect(extractChangelogSection(LOG, '9.9.9')).toBeNull();
  });

  it('ignores a heading that is not at the start of a line', () => {
    expect(extractChangelogSection('text ## v1.2.3 (2026-01-01)\n', '1.2.3')).toBeNull();
  });

  it('finds a heading on the first line', () => {
    expect(extractChangelogSection('## v1.0.0 (2026-01-01)\n\n- a\n', '1.0.0')).toBe('## v1.0.0 (2026-01-01)\n\n- a\n');
  });

  it('rejects an invalid version', () => {
    expect(() => extractChangelogSection(LOG, '1.2.*')).toThrow();
  });
});
