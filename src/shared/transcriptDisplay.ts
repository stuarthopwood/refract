/** Two independent view filters for the chat transcript, applied in the renderer. */
export interface TranscriptDisplaySettings {
  thinking: boolean;
  toolCalls: boolean;
  /** Show each tool row's raw tool id, muted, after its label. A display option, not a filter: it hides nothing. */
  toolNames: boolean;
}

export const DEFAULT_TRANSCRIPT_DISPLAY: Readonly<TranscriptDisplaySettings> = Object.freeze({
  thinking: true,
  toolCalls: true,
  toolNames: false,
});
