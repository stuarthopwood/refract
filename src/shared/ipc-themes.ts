// Custom theme files (#458, spec 078): the shapes `themes.*` return.
import type { Result } from './ipc';
import type { Settings } from './model';
import type { ThemeId } from './themes';

export interface CustomTheme {
  id: string;
  name: string;
  base: ThemeId;
  tokens: Record<string, string>;
}

export interface RejectedTheme { file: string; error: string }
export interface ThemeList { themes: CustomTheme[]; rejected: RejectedTheme[] }

export interface ThemesApi {
  list(): Promise<Result<ThemeList>>;
  /** Null when the picker is cancelled. */
  import(): Promise<Result<CustomTheme | null>>;
  /** Writes the JSON where the user picks; null when cancelled. */
  export(suggestedName: string, json: string): Promise<Result<string | null>>;
  remove(id: string): Promise<Result<null>>;
  /** With an id, selects that file; without, opens the folder. */
  openFolder(id?: string): Promise<Result<null>>;
  setCustom(id: string | null): Promise<Result<Settings>>;
}
