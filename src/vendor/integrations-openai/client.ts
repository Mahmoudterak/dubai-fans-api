import OpenAI from "openai";

// Lazy-init: CF Workers receives env vars only at request time, not at module
// load time. Use a Proxy so the check happens on first property access.
let _openai: OpenAI | null = null;

function resolveOpenAI(): OpenAI {
  if (!_openai) {
    if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
      throw new Error(
        "AI_INTEGRATIONS_OPENAI_BASE_URL must be set. Did you forget to provision the OpenAI AI integration?",
      );
    }
    if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
      throw new Error(
        "AI_INTEGRATIONS_OPENAI_API_KEY must be set. Did you forget to provision the OpenAI AI integration?",
      );
    }
    _openai = new OpenAI({
      apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
      baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    });
  }
  return _openai;
}

export const openai: OpenAI = new Proxy({} as OpenAI, {
  get(_t, prop, receiver) {
    return Reflect.get(resolveOpenAI(), prop, receiver);
  },
});
