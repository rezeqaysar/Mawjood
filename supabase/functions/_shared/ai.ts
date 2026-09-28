// Shared AI provider config for edge functions.
//
// Premium path (user's call: intelligence over cost): when OPENAI_API_KEY is
// set, chat runs on OpenAI GPT-5-mini; transcription stays on Groq's free
// whisper while GROQ_API_KEY exists. Otherwise everything stays on Groq free.

export interface AiConfig {
  provider: 'groq' | 'openai';
  base: string;
  key: string;
  transcribeModel: string;
  transcribeBase: string;
  transcribeKey: string;
  chatModel: string;
  visionModel: string;
  /** GPT-5.x rejects non-default temperature — omit it when false. */
  supportsTemperature: boolean;
  /** GPT-5.x rejects max_tokens with a 400 — send max_completion_tokens when false. */
  supportsMaxTokens: boolean;
}

export function aiConfig(): AiConfig {
  const groq = Deno.env.get('GROQ_API_KEY');
  const openai = Deno.env.get('OPENAI_API_KEY');

  if (openai) {
    return {
      provider: 'openai',
      base: 'https://api.openai.com/v1',
      key: openai,
      transcribeModel: groq ? 'whisper-large-v3-turbo' : 'gpt-4o-mini-transcribe',
      transcribeBase: groq ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1',
      transcribeKey: groq ?? openai,
      chatModel: 'gpt-5-mini',
      visionModel: 'gpt-4o-mini',
      supportsTemperature: false,
      supportsMaxTokens: false,
    };
  }
  return {
    provider: 'groq',
    base: 'https://api.groq.com/openai/v1',
    key: groq ?? '',
    transcribeModel: 'whisper-large-v3-turbo',
    transcribeBase: 'https://api.groq.com/openai/v1',
    transcribeKey: groq ?? '',
    chatModel: 'openai/gpt-oss-120b',
    visionModel: 'qwen/qwen3.8-27b',
    supportsTemperature: true,
    supportsMaxTokens: true,
  };
}

/** Build a chat-completions body: the right token-cap param and temperature per model. */
export function chatBody(
  ai: AiConfig,
  opts: { max_tokens: number; messages: unknown[] },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: ai.chatModel,
    messages: opts.messages,
  };
  if (ai.supportsMaxTokens) body.max_tokens = opts.max_tokens;
  else body.max_completion_tokens = opts.max_tokens;
  if (ai.supportsTemperature) body.temperature = 0.2;
  return body;
}
