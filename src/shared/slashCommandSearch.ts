// Fuzzy slash-command search (issue #947, decided as delegated, away mode -- see the issue body
// for the full decision record). Pure, no DOM: filters and ranks what the slash menu shows, it
// never changes what `chat.send`/`classifySlashInvocation` (slash-commands.ts) accepts or sends.
//
// Decision 1: applies to every command Refract lists -- built-ins, project/user `file` commands,
// and `skill:<name>` entries -- from one ranked list, not a separate rule per source.
// Decision 2: a skill matches on its name WITH or WITHOUT the `skill:` prefix (`/rev` finds
// `skill:code-review`; `/skill` lists every skill via an ordinary prefix match on the full name).
// Decision 3: ranking tiers, best first: exact, then prefix, then word-start (a match starting
// right after `-`, `_`, `:` or a space), then substring, then subsequence (fzy-style: the
// needle's letters appear in order, gaps allowed). Ties keep the input order (callers already
// list built-ins first).
// Decision 4: the description is searched too, but only once no name/alias match exists at all --
// a description-only match always ranks below every name match, regardless of tier. Amended
// (FR-073, gate round 1): a description hit only counts at the word-start or substring tier,
// never subsequence -- a subsequence match against a whole prose sentence barely narrows
// anything (the needle's letters merely need to appear somewhere, in order, with unlimited
// gaps).
// Decision 5: matched characters in the rendered NAME are returned as bold spans; nothing in the
// description is ever bolded (the description is not itself searched for highlighting, only for
// whether it counts as a match at all).

import type { SlashCommandDescriptor } from './frames';

/** A contiguous run of matched characters, as `[start, end)` indices into the command's own
 * `name` (never into an alias or the stripped `skill:` form -- those are mapped back onto `name`
 * before being returned, since `name` is the only thing ever rendered). */
export type SlashMatchRange = readonly [number, number];

export interface SlashCommandMatch {
  command: SlashCommandDescriptor;
  /** Bold spans into `command.name`, in ascending, non-overlapping order; empty when the match
   * came from an alias (not rendered) or the description (never bolded, decision 4/5). */
  nameMatchRanges: readonly SlashMatchRange[];
}

// Lower is better; matches the order decision 3 lists. `DESCRIPTION` is deliberately far below
// every name tier so a description-only hit can never outrank even a subsequence name match.
const TIER_EXACT = 0;
const TIER_PREFIX = 1;
const TIER_WORD_START = 2;
const TIER_SUBSTRING = 3;
const TIER_SUBSEQUENCE = 4;
const TIER_DESCRIPTION = 5;

const WORD_BOUNDARY_CHARS: Readonly<Record<string, true>> = { '-': true, '_': true, ':': true, ' ': true };

interface TargetMatch {
  tier: number;
  ranges: SlashMatchRange[];
}

/** Scores `needle` (already lower-cased, non-empty) against `target` (raw case): the best tier
 * decision 3 recognises, or `null` for no match at all. */
function scoreAgainstTarget(needle: string, target: string): TargetMatch | null {
  const lower = target.toLowerCase();
  if (lower === needle) return { tier: TIER_EXACT, ranges: [[0, target.length]] };
  if (lower.startsWith(needle)) return { tier: TIER_PREFIX, ranges: [[0, needle.length]] };
  for (let i = 1; i + needle.length <= lower.length; i++) {
    if (!WORD_BOUNDARY_CHARS[lower[i - 1]!]) continue;
    if (lower.slice(i, i + needle.length) === needle) return { tier: TIER_WORD_START, ranges: [[i, i + needle.length]] };
  }
  const substringIndex = lower.indexOf(needle);
  if (substringIndex !== -1) return { tier: TIER_SUBSTRING, ranges: [[substringIndex, substringIndex + needle.length]] };
  const subsequenceRanges = matchSubsequence(needle, lower);
  if (subsequenceRanges) return { tier: TIER_SUBSEQUENCE, ranges: subsequenceRanges };
  return null;
}

/** Greedy left-to-right subsequence match (fzy-style: the needle's letters appear in order in
 * the target, gaps allowed), merging adjacent matched characters into one bold span so a mostly-
 * contiguous match (one gap) does not render as a string of single-letter spans. */
function matchSubsequence(needle: string, lowerTarget: string): SlashMatchRange[] | null {
  const ranges: SlashMatchRange[] = [];
  let targetIndex = 0;
  for (let needleIndex = 0; needleIndex < needle.length; needleIndex++) {
    const char = needle[needleIndex]!;
    const found = lowerTarget.indexOf(char, targetIndex);
    if (found === -1) return null;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === found) {
      ranges[ranges.length - 1] = [last[0], found + 1];
    } else {
      ranges.push([found, found + 1]);
    }
    targetIndex = found + 1;
  }
  return ranges;
}

/** One candidate string to score `needle` against for a given command: `name` itself, the
 * `skill:`-stripped form for a skill command (decision 2), and each alias. `offset` maps a
 * match's ranges back onto `command.name`'s own indices; `mapsToName` is false for an alias,
 * whose text is never rendered, so a match there earns its tier but no bold span. */
interface NameCandidate {
  text: string;
  offset: number;
  mapsToName: boolean;
}

const SKILL_PREFIX = 'skill:';

function buildNameCandidates(command: SlashCommandDescriptor): NameCandidate[] {
  const candidates: NameCandidate[] = [{ text: command.name, offset: 0, mapsToName: true }];
  if (command.name.toLowerCase().startsWith(SKILL_PREFIX)) {
    candidates.push({ text: command.name.slice(SKILL_PREFIX.length), offset: SKILL_PREFIX.length, mapsToName: true });
  }
  for (const alias of command.aliases ?? []) {
    candidates.push({ text: alias, offset: 0, mapsToName: false });
  }
  return candidates;
}

interface CommandMatchResult {
  match: SlashCommandMatch;
  /** The tier this command actually RANKS at -- the best tier any candidate (name, its
   * `skill:`-stripped form, or an alias) reached, or `TIER_DESCRIPTION` for a description-only
   * hit. Gate-fix (High, round 1): previously discarded by the caller, which re-scored against
   * `command.name` alone -- wrong the moment the WINNING candidate was the stripped-skill form
   * (a bare-name prefix match on a skill fell to word-start against the full `skill:` name) or
   * an alias (an exact alias match fell all the way to `TIER_DESCRIPTION` whenever the command
   * also had a description, since an alias's own ranges never map onto `name`). */
  tier: number;
}

function matchCommand(needle: string, command: SlashCommandDescriptor): CommandMatchResult | null {
  // Tier to RANK by: the best across every candidate, name/stripped-skill-form/alias alike --
  // whichever actually lets this command match best, regardless of whether it is ever rendered.
  let bestTier: number | null = null;
  for (const candidate of buildNameCandidates(command)) {
    const scored = scoreAgainstTarget(needle, candidate.text);
    if (scored && (bestTier === null || scored.tier < bestTier)) bestTier = scored.tier;
  }
  if (bestTier !== null) {
    // Bold ranges to RENDER: computed separately, only from the candidates that map onto
    // `command.name` (the name itself, or a skill's own stripped form) -- independent of which
    // candidate won the tier above, so a name that also matches (at a worse tier than the alias
    // that won the ranking) still shows its own bold span instead of none at all.
    let bestNameTier: number | null = null;
    let bestNameRanges: SlashMatchRange[] = [];
    for (const candidate of buildNameCandidates(command)) {
      if (!candidate.mapsToName) continue;
      const scored = scoreAgainstTarget(needle, candidate.text);
      if (scored && (bestNameTier === null || scored.tier < bestNameTier)) {
        bestNameTier = scored.tier;
        bestNameRanges = scored.ranges.map(([start, end]): SlashMatchRange => [start + candidate.offset, end + candidate.offset]);
      }
    }
    return { match: { command, nameMatchRanges: bestNameRanges }, tier: bestTier };
  }
  // Gate-fix (High, round 1): restricted to word-start or substring (decision 4 amended, FR-073)
  // -- a description-only SUBSEQUENCE hit used to count too, which for a two- or three-letter
  // needle matched almost every command's own prose description (the needle's letters merely
  // had to appear somewhere, in order, with unlimited gaps), so the list barely narrowed at all.
  const descriptionMatch = command.description ? scoreAgainstTarget(needle, command.description) : null;
  if (descriptionMatch && descriptionMatch.tier <= TIER_SUBSTRING) {
    return { match: { command, nameMatchRanges: [] }, tier: TIER_DESCRIPTION };
  }
  return null;
}

/** Ranks `commands` against `query` (the typed text, NOT yet lower-cased) per decision 3: exact,
 * prefix, word-start, substring, subsequence, then a description-only match (word-start or
 * substring only, FR-073 amendment), each tier a stable sort keeping `commands`' own input order
 * as the tie-break (decision 3: "ties keep the current order", i.e. built-ins first, since
 * callers already list them first). An empty query matches every command, unchanged order, with
 * no bold spans -- the empty-query shape the slash menu shows the instant `/` is typed, before
 * anything else. */
export function rankSlashCommands(query: string, commands: readonly SlashCommandDescriptor[]): SlashCommandMatch[] {
  const needle = query.toLowerCase();
  if (needle === '') return commands.map((command) => ({ command, nameMatchRanges: [] }));
  const matched: Array<{ match: SlashCommandMatch; tier: number; index: number }> = [];
  commands.forEach((command, index) => {
    const result = matchCommand(needle, command);
    if (!result) return;
    matched.push({ match: result.match, tier: result.tier, index });
  });
  matched.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return matched.map((entry) => entry.match);
}
