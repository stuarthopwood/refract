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

  it('keeps the England and Wales subdivision-flag tag sequences', () => {
    const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
    expect(sanitiseForClipboard(england)).toBe(england);
    const wales = '\u{1F3F4}\u{E0077}\u{E006C}\u{E0073}\u{E007F}';
    expect(sanitiseForClipboard(wales)).toBe(wales);
  });

  it('keeps tag sequences at the 7-tag upper and 3-tag lower lengths', () => {
    const sevenTags = '\u{1F3F4}\u{E0065}\u{E006E}\u{E0067}\u{E006C}\u{E0061}\u{E006E}\u{E0064}\u{E007F}';
    expect(sanitiseForClipboard(sevenTags)).toBe(sevenTags);
    const threeTags = '\u{1F3F4}\u{E0077}\u{E006C}\u{E0073}\u{E007F}';
    expect(sanitiseForClipboard(threeTags)).toBe(threeTags);
  });

  it('strips an unterminated tag sequence (no cancel tag) down to the bare flag base', () => {
    const noCancel = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}';
    expect(sanitiseForClipboard(noCancel)).toBe('\u{1F3F4}');
  });

  it('strips an unterminated tag sequence but keeps trailing real text', () => {
    const noCancel = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}x';
    expect(sanitiseForClipboard(noCancel)).toBe('\u{1F3F4}x');
  });

  it('strips 8 lowercase tag letters plus a cancel tag (over the 7-tag flag limit) down to the bare flag', () => {
    const eightTags = '\u{1F3F4}\u{E0061}\u{E0062}\u{E0063}\u{E0064}\u{E0065}\u{E0066}\u{E0067}\u{E0068}\u{E007F}';
    expect(sanitiseForClipboard(eightTags)).toBe('\u{1F3F4}');
  });

  it('strips uppercase tag letters plus a cancel tag down to the bare flag (only lowercase ASCII tags are a real subdivision code)', () => {
    const upperTags = '\u{1F3F4}\u{E0047}\u{E0042}\u{E0053}\u{E0043}\u{E0054}\u{E007F}';
    expect(sanitiseForClipboard(upperTags)).toBe('\u{1F3F4}');
  });

  it('strips a tag sequence on a non-flag emoji base down to the bare base', () => {
    const nonFlagBase = '\u{1F600}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    expect(sanitiseForClipboard(nonFlagBase)).toBe('\u{1F600}');
  });

  it('strips a tag character between plain text, keeping the text', () => {
    expect(sanitiseForClipboard('a\u{E0001}\u{E007F}b')).toBe('ab');
  });

  it('keeps a valid flag sequence but strips extra trailing tag characters', () => {
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    const withExtra = scotland + '\u{E0041}\u{E0042}';
    expect(sanitiseForClipboard(withExtra)).toBe(scotland);
  });

  it('strips a tag character spliced between two unpaired surrogates (surrogate-splice bypass, cycle 4)', () => {
    const splice = '\uDB40' + '\u{E0001}' + '\uDC69';
    expect(sanitiseForClipboard(splice)).toBe('');
  });

  it('strips a nested-pair splice payload (two high surrogates, a tag character, two low surrogates)', () => {
    const nested = '\uDB40\uDB40' + '\u{E0001}' + '\uDC69\uDC69';
    expect(sanitiseForClipboard(nested)).toBe('');
  });

  // The C0/bidi pass must run first: it makes \uDB40+\uDC69 adjacent so the tag pass strips them as U+E0069.
  it('strips a C0 control sandwiched between unpaired surrogate halves (pass-order regression)', () => {
    const spliced = '\uDB40' + '\u0001' + '\uDC69';
    expect(sanitiseForClipboard(spliced)).toBe('');
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

  it('keeps a plain astral (surrogate-pair) emoji intact', () => {
    const grinning = '\u{1F600}';
    expect(sanitiseForClipboard(grinning)).toBe(grinning);
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
