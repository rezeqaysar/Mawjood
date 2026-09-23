// Shared AI provider config for edge functions.
// Groq (free tier, no card) is used when GROQ_API_KEY is set — its endpoints
// are OpenAI-compatible, so the swap is a drop-in. Otherwise OpenAI is used
// (production path, needs OPENAI_API_KEY with billing).

export interface AiConfig {
  provider: 'groq' | 'openai';
  base: string;
  key: string;
  transcribeModel: string;
  chatModel: string;
  visionModel: string;
}

export function aiConfig(): AiConfig {
  const groq = Deno.env.get('GROQ_API_KEY');
  if (groq) {
    return {
      provider: 'groq',
      base: 'https://api.groq.com/openai/v1',
      key: groq,
      transcribeModel: 'whisper-large-v3-turbo',
      chatModel: 'openai/gpt-oss-120b',
      visionModel: 'qwen/qwen3.6-27b',
    };
  }
  return {
    provider: 'openai',
    base: 'https://api.openai.com/v1',
    key: Deno.env.get('OPENAI_API_KEY') ?? '',
    transcribeModel: 'gpt-4o-mini-transcribe',
    chatModel: 'gpt-4o-mini',
    visionModel: 'gpt-4o-mini',
  };
}
