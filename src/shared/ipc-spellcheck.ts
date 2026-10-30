// The `spellcheck.*` IPC contract (#1431): Windows Spell Checking API suggestions for the composer menu.

import type { Result } from './ipc';

export interface SpellcheckApi {
  /** Up to five suggestions for a misspelled `word` under the BCP 47 `language`; empty when it is spelled correctly or unsupported. */
  suggest(word: string, language: string): Promise<Result<string[]>>;
  /** Adds `word` to the user's Windows dictionary for `language`. */
  add(word: string, language: string): Promise<Result<void>>;
}
