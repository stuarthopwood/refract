// Separate from `lib/modelRoles.ts` to avoid a circular import via `ModelRolesSection.tsx` (#1069).
// Keyed on OMP's `provider` field, never a display string split on `/`.
const PROVIDER_LABEL: Record<string, string> = {
  'github-copilot': 'GitHub Copilot',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI Codex',
  'azure-openai': 'Azure OpenAI',
  google: 'Google',
  'google-vertex': 'Google Vertex AI',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  ollama: 'Ollama',
  'llama.cpp': 'llama.cpp',
  'lm-studio': 'LM Studio',
  litellm: 'LiteLLM',
  bedrock: 'Amazon Bedrock',
  local: 'Local',
  apple: 'Apple'
}

/** A friendly provider name, or the raw id unchanged when unknown. */
export function friendlyProviderLabel(provider: string): string {
  // `hasOwn` so ids like `constructor` can't return an inherited prototype member. (#1114)
  return Object.hasOwn(PROVIDER_LABEL, provider) ? (PROVIDER_LABEL[provider] as string) : provider
}
