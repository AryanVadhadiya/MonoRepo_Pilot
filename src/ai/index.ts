import type { LLMProvider } from "./provider.js";
import { GeminiProvider } from "./gemini.js";
import { MockProvider } from "./mock.js";

export * from "./provider.js";
export * from "./gemini.js";
export * from "./mock.js";
export * from "./evidence.js";
export * from "./schema.js";
export * from "./prompt.js";
export * from "./pipeline.js";

export interface CreateProviderOptions {
  provider?: string;
  model?: string;
}

export function createProvider(options?: CreateProviderOptions): LLMProvider {
  const providerName = (
    options?.provider ||
    process.env.REPOPILOT_PROVIDER ||
    "gemini"
  ).toLowerCase();

  const model = options?.model || process.env.REPOPILOT_MODEL;

  switch (providerName) {
    case "mock":
      return new MockProvider(model);

    case "gemini":
      return new GeminiProvider(undefined, model);

    // -------------------------------------------------------------
    // FUTURE PROVIDER: Ollama
    // Will run local Gemma with concurrency = 1
    // case "ollama":
    //   return new OllamaProvider(model);
    // -------------------------------------------------------------

    default:
      throw new Error(
        `Unsupported REPOPILOT_PROVIDER: "${providerName}". Supported providers: "gemini", "mock".`
      );
  }
}
