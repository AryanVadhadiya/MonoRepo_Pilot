export interface GenerateOptions {
  system?: string;
  user: string;
  jsonSchema?: Record<string, unknown>;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly concurrency: number;
  generate(options: GenerateOptions): Promise<string>;
}

/**
 * Strips markdown code fences and extracts the first JSON object {...}.
 */
export function parseJsonLoose<T = unknown>(text: string): T {
  let cleaned = text.trim();

  // Strip markdown code fences if present
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  // Attempt direct JSON parse first
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Locate the first opening brace '{'
    const start = cleaned.indexOf("{");
    if (start === -1) {
      throw new Error(`Failed to parse JSON: No opening brace found in text: ${text}`);
    }

    // Find the matching closing brace while respecting string quotes and escapes
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let end = -1;

    for (let i = start; i < cleaned.length; i++) {
      const char = cleaned[i];
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (char === "\\") {
        escapeNext = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === "{") depth++;
        else if (char === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
    }

    if (end === -1) {
      // Fallback regex attempt for { ... }
      const braceMatch = cleaned.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        return JSON.parse(braceMatch[0]) as T;
      }
      throw new Error(`Failed to parse JSON: No matching closing brace found in text: ${text}`);
    }

    const candidate = cleaned.slice(start, end + 1);
    return JSON.parse(candidate) as T;
  }
}
