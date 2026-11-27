/** Where a tool row shows its target (path, command, pattern, URL): hidden, in a tooltip on the verb, or in the row (#1758). */
export type ToolTargets = 'hide' | 'hover' | 'show';

export const TOOL_TARGETS_VALUES: ReadonlyArray<ToolTargets> = ['hide', 'hover', 'show'];

export function isToolTargets(value: unknown): value is ToolTargets {
  return TOOL_TARGETS_VALUES.includes(value as ToolTargets);
}

/** Two independent view filters for the chat transcript, applied in the renderer. */
export interface TranscriptDisplaySettings {
  thinking: boolean;
  toolCalls: boolean;
  /** Show each tool row's raw tool id, muted, after its label. A display option, not a filter: it hides nothing. */
  toolNames: boolean;
  /** Open answered Ask rows in the transcript. A display option, not a filter: a row can still be collapsed by hand. */
  expandAnsweredAsks: boolean;
  /** Where tool rows show their target (#1758). Written through its own `setToolTargets`, not the boolean `setTranscriptDisplay`. */
  toolTargets: ToolTargets;
}

/** The boolean fields `setTranscriptDisplay` merges one at a time. */
export type TranscriptDisplayFlag = Exclude<keyof TranscriptDisplaySettings, 'toolTargets'>;

export const DEFAULT_TRANSCRIPT_DISPLAY: Readonly<TranscriptDisplaySettings> = Object.freeze({
  thinking: true,
  toolCalls: true,
  toolNames: false,
  expandAnsweredAsks: true,
  toolTargets: 'hover',
});
