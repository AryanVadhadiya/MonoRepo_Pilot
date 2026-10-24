import type { GenerateOptions, LLMProvider } from "./provider.js";

export class MockProvider implements LLMProvider {
  readonly name = "mock";
  readonly model: string;
  readonly concurrency = 4;
  private callCount = 0;

  constructor(model?: string) {
    this.model = model || process.env.REPOPILOT_MODEL || "mock-model";
  }

  async generate(options: GenerateOptions): Promise<string> {
    this.callCount++;
    const mode = (process.env.REPOPILOT_MOCK_MODE || "").toLowerCase();

    // 1. Simulated Failure Mode
    if (mode === "fail") {
      throw new Error("Mock provider simulated network failure (503 Service Unavailable)");
    }

    // 2. Bad Mode: Test Repair Retry & Grounding Guardrails
    if (mode === "bad") {
      // First call: Return malformed / invalid JSON wrapped in prose
      if (this.callCount === 1) {
        return "I analyzed your repository. Here is the report:\n```json\n{ summary: \"Malformed JSON missing quotes and brace";
      }

      // Subsequent call (Repair): Return JSON with ungrounded hallucinated citations
      return JSON.stringify({
        summary: "Mock analysis with bad grounding citations to verify guardrail filtering.",
        riskLevel: "high",
        findings: [
          {
            title: "Hallucinated finding with invalid evidence",
            severity: "high",
            kind: "verified",
            explanation: "This finding references nonexistent evidence E999 and should be dropped.",
            evidenceIds: ["E999"],
            affectedPackages: ["nonexistent-pkg", "@demo/api"],
            confidence: "high",
          },
          {
            title: "Grounded finding with real evidence",
            severity: "high",
            kind: "verified",
            explanation: "This finding cites real evidence E1 from the prompt.",
            evidenceIds: ["E1"],
            affectedPackages: ["nonexistent-pkg", "@demo/api"],
            confidence: "high",
          },
        ],
        recommendedTests: [
          { testId: "T99", reason: "Hallucinated nonexistent test" },
          { testId: "T1", reason: "Real test recommended from prompt" },
        ],
        uncertainties: ["Simulated uncertainty item"],
      });
    }

    // 3. Normal Mode: Extract real evidence IDs and test IDs from prompt text
    const evidenceMatches = Array.from(options.user.matchAll(/\bid="(E\d+)"/g)).map((m) => m[1]);
    const testMatches = Array.from(options.user.matchAll(/\bid="(T\d+)"/g)).map((m) => m[1]);

    const citedEvidence = evidenceMatches.length > 0 ? evidenceMatches.slice(0, 2) : ["E1"];
    const citedTests = testMatches.length > 0
      ? testMatches.slice(0, 2).map((t) => ({
          testId: t,
          reason: "Covers changed package exports directly or via dependency path",
        }))
      : [];

    return JSON.stringify({
      summary: "Deterministic AI impact evaluation based on extracted workspace evidence.",
      riskLevel: "high",
      findings: [
        {
          title: "Export signature change affecting dependents",
          severity: "high",
          kind: "verified",
          explanation:
            "A modified export function signature creates call-site mismatches in dependent packages.",
          evidenceIds: citedEvidence,
          affectedPackages: ["@demo/api"],
          confidence: "high",
        },
      ],
      recommendedTests: citedTests,
      uncertainties: [],
    });
  }
}
