// Quality-gate remediation (cycle 2, PR #597): regression coverage for the clipboard sanitiser
// (security review rounds 1-2 -- pastejacking via C0/C1 controls, Trojan Source bidi overrides).
import { describe, it, expect } from 'vitest';
import { sanitiseForClipboard } from './clipboard-sanitise';

describe('sanitiseForClipboard', () => {
  it('keeps plain text unchanged', () => {
    expect(sanitiseForClipboard('export function add(a, b) {\n  return a + b\n}')).toBe(
      'export function add(a, b) {\n  return a + b\n}',
    );
  });

  it('keeps tab characters', () => {
    expect(sanitiseForClipboard('a\tb')).toBe('a\tb');
  });

  it('keeps LF line breaks', () => {
    expect(sanitiseForClipboard('line1\nline2')).toBe('line1\nline2');
  });

  it('keeps CRLF line breaks intact', () => {
    expect(sanitiseForClipboard('line1\r\nline2')).toBe('line1\r\nline2');
  });

  it('converts a lone CR (not part of CRLF) to LF', () => {
    expect(sanitiseForClipboard('line1\rline2')).toBe('line1\nline2');
  });

  it('converts a lone CR even when followed by more lone CRs', () => {
    expect(sanitiseForClipboard('a\rb\rc')).toBe('a\nb\nc');
  });

  it('keeps vertical tab (U+000B)', () => {
    expect(sanitiseForClipboard('a\u000Bb')).toBe('a\u000Bb');
  });

  it('keeps form feed (U+000C)', () => {
    expect(sanitiseForClipboard('a\u000Cb')).toBe('a\u000Cb');
  });

  it('strips other C0 control characters', () => {
    expect(sanitiseForClipboard('a\u0000b\u0001c\u001Fd')).toBe('abcd');
  });

  it('strips ESC (used by ANSI/bracketed-paste escape sequences)', () => {
    expect(sanitiseForClipboard('a\u001B[31mb')).toBe('a[31mb');
  });

  it('strips DEL', () => {
    expect(sanitiseForClipboard('a\u007Fb')).toBe('ab');
  });

  it('strips C1 control characters (U+0080-U+009F)', () => {
    expect(sanitiseForClipboard('a\u0085b\u009Bc')).toBe('abc');
  });

  it('strips bidi override and isolate characters (Trojan Source, CVE-2021-42574)', () => {
    expect(sanitiseForClipboard('a\u202Eb\u202Ac\u2066d\u2069e')).toBe('abcde');
  });

  it('keeps LRM/RLM marks used by legitimate bidi text', () => {
    expect(sanitiseForClipboard('a\u200Eb\u200Fc')).toBe('a\u200Eb\u200Fc');
  });

  it('keeps Arabic text intact', () => {
    const arabic = 'مرحبا بالعالم';
    expect(sanitiseForClipboard(arabic)).toBe(arabic);
  });

  it('keeps Hebrew text intact', () => {
    const hebrew = 'שלום עולם';
    expect(sanitiseForClipboard(hebrew)).toBe(hebrew);
  });

  it('reduces a block made entirely of stripped characters to the empty string', () => {
    expect(sanitiseForClipboard('\u0000\u202E\u007F')).toBe('');
  });
});
