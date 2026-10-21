// Friendly provider display names (#741 Part 1: "a small map for the known providers... with the
// raw id as the fallback; no new dependency"). Extracted out of `lib/modelRoles.ts` (issue #1069)
// so a Model roles component that needs the switch's own segment labels can import it directly
// without pulling in `modelRoles.ts`'s own top-level import of `ModelRolesSection.tsx`'s
// `CHAT_ROLE_DESCRIPTORS` -- `ModelRolesSection.tsx` now imports `ProviderSwitch.tsx`, and
// `ProviderSwitch.tsx` importing `modelRoles.ts` back would be a real circular import (that file
// reads `CHAT_ROLE_DESCRIPTORS` at its own module top level), not merely a theoretical one. Built
// from the fields OMP already reports (`provider`), never by splitting a display string on `/` --
// an id such as `openrouter/google/gemini` stays untouched by any caller that uses this map
// correctly. `lib/modelRoles.ts` re-exports `friendlyProviderLabel` from here so every existing
// import site (`@/lib/modelRoles`) is unchanged.
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

/** `provider` -> a friendly display name, or the raw id unchanged when it is not in the map
 * (#741 Part 1: "no name (only an id): show the id as is; do not invent a prettified name" --
 * the same rule applied here to an unrecognised PROVIDER id, not just an unrecognised model
 * name). */
export function friendlyProviderLabel(provider: string): string {
  // Gate round 1 fix (#1114, Low): `Object.hasOwn` rather than bracket access + `??`, so a
  // provider id that happens to collide with an `Object.prototype` member name (e.g.
  // `"constructor"`, `"toString"`) can never return that inherited function instead of falling
  // through to the raw-id fallback.
  return Object.hasOwn(PROVIDER_LABEL, provider) ? (PROVIDER_LABEL[provider] as string) : provider
}
