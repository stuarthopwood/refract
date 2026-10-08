// Quality-gate remediation (cycles 2-3, PR #597): regression coverage for the clipboard
// sanitiser (security review rounds 1-3 -- pastejacking via C0/C1 controls, Trojan Source bidi
// overrides, deprecated format controls, Unicode tag-character ASCII smuggling).
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

  it('normalises mixed lone CR and CRLF in the same string', () => {
    expect(sanitiseForClipboard('a\r\r\nb\r')).toBe('a\n\r\nb\n');
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

  it('strips the deprecated invisible format controls (U+206A-U+206F, U+FFF9-U+FFFB)', () => {
    expect(sanitiseForClipboard('a\u206Ab\u206Fc\uFFF9d\uFFFBe')).toBe('abcde');
  });

  it('strips bare Unicode tag characters (ASCII smuggling)', () => {
    expect(sanitiseForClipboard('a\u{E0049}\u{E0047}b')).toBe('ab');
  });

  it('keeps a well-formed emoji tag-sequence flag (Scotland subdivision flag)', () => {
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    expect(sanitiseForClipboard(scotland)).toBe(scotland);
  });

  it('keeps LRM/RLM marks used by legitimate bidi text', () => {
    expect(sanitiseForClipboard('a\u200Eb\u200Fc')).toBe('a\u200Eb\u200Fc');
  });

  it('keeps U+061C (Arabic Letter Mark)', () => {
    expect(sanitiseForClipboard('a\u061Cb')).toBe('a\u061Cb');
  });

  it('keeps RTL text with LRM/RLM/ALM but strips an embedded bidi override', () => {
    const withOverride = '\u05E9\u05DC\u05D5\u05DD\u200F x \u0645\u0631\u062D\u0628\u0627\u200E\u061C\u202E!';
    const expected = '\u05E9\u05DC\u05D5\u05DD\u200F x \u0645\u0631\u062D\u0628\u0627\u200E\u061C!';
    expect(sanitiseForClipboard(withOverride)).toBe(expected);
  });

  it('keeps emoji ZWJ sequences, variation selectors, skin-tone modifiers and regional-indicator flags', () => {
    const s = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} \u2764\uFE0F \u{1F44D}\u{1F3FD} \u{1F1EC}\u{1F1E7}';
    expect(sanitiseForClipboard(s)).toBe(s);
  });

  it('keeps Arabic text intact', () => {
    const arabic = '\u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645';
    expect(sanitiseForClipboard(arabic)).toBe(arabic);
  });

  it('keeps Hebrew text intact', () => {
    const hebrew = '\u05E9\u05DC\u05D5\u05DD \u05E2\u05D5\u05DC\u05DD';
    expect(sanitiseForClipboard(hebrew)).toBe(hebrew);
  });

  it('reduces a block made entirely of stripped characters to the empty string', () => {
    expect(sanitiseForClipboard('\u0000\u202E\u007F')).toBe('');
  });

  it('sanitises a large block linearly, without quadratic blowup', () => {
    const input = 'x\u001B\r'.repeat(350_000);
    expect(sanitiseForClipboard(input)).toBe('x\n'.repeat(350_000));
  });
});
