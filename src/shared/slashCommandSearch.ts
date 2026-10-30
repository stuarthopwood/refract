
import type { SlashCommandDescriptor } from './frames';

/** A contiguous run of matched characters as `[start, end)` indices into the command's `name`. */
export type SlashMatchRange = readonly [number, number];

export interface SlashCommandMatch {
  command: SlashCommandDescriptor;
  nameMatchRanges: readonly SlashMatchRange[];
}

// Lower is better. `DESCRIPTION` sits far below every name tier so a description-only hit never outranks a name match.
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
  tier: number;
}

function matchCommand(needle: string, command: SlashCommandDescriptor): CommandMatchResult | null {
  let bestTier: number | null = null;
  for (const candidate of buildNameCandidates(command)) {
    const scored = scoreAgainstTarget(needle, candidate.text);
    if (scored && (bestTier === null || scored.tier < bestTier)) bestTier = scored.tier;
  }
  if (bestTier !== null) {
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
  const descriptionMatch = command.description ? scoreAgainstTarget(needle, command.description) : null;
  if (descriptionMatch && descriptionMatch.tier <= TIER_SUBSTRING) {
    return { match: { command, nameMatchRanges: [] }, tier: TIER_DESCRIPTION };
  }
  return null;
}

/** Ranks `commands` against `query` (the typed text, not yet lower-cased). */
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
