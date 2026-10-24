import { GoogleGenAI } from "@google/genai";
import type { GenerateOptions, LLMProvider } from "./provider.js";

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly model: string;
  readonly concurrency = 4;
  private readonly ai: GoogleGenAI;

  constructor(apiKey?: string, model?: string) {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error(
        "GEMINI_API_KEY is missing. Please set GEMINI_API_KEY in your environment or .env file."
      );
    }
    this.model = model || process.env.REPOPILOT_MODEL || "gemini-3.8-flash";
    this.ai = new GoogleGenAI({ apiKey: key });
  }

  async generate(options: GenerateOptions): Promise<string> {
    const timeoutMs = 20000; // 20s timeout
    const config: Record<string, unknown> = {
      temperature: 0.1,
      responseMimeType: "application/json",
      abortSignal: AbortSignal.timeout(timeoutMs),
    };

    if (options.system) {
      config.systemInstruction = options.system;
    }

    if (options.jsonSchema) {
      config.responseJsonSchema = options.jsonSchema;
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Gemini generate request timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      timer.unref?.();
    });

    const generatePromise = this.ai.models.generateContent({
      model: this.model,
      contents: options.user,
      config,
    });

    const response = await Promise.race([generatePromise, timeoutPromise]);

    const text = response.text;
    if (typeof text !== "string") {
      throw new Error("Gemini returned empty or invalid response text.");
    }
    return text;
  }
}
