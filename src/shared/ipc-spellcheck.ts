// The `spellcheck.*` IPC contract (#1431): Windows Spell Checking API suggestions for the composer menu.

import type { Result } from './ipc';

export interface SpellSuggestion {
  /** True when the word is misspelt, even with no suggestions, so "Add to dictionary" can show. */
  misspelt: boolean
  suggestions: string[]
}

export interface SpellcheckApi {
  /** Up to five suggestions for `word` under the BCP 47 `language`; not misspelt when spelled correctly or unsupported. */
  suggest(word: string, language: string): Promise<Result<SpellSuggestion>>;
  /** Adds `word` to the user's Windows dictionary for `language`. */
  add(word: string, language: string): Promise<Result<void>>;
}
