import { z } from "zod";

export const findingSchema = z.object({
  title: z.string().max(100),
  severity: z.enum(["low", "medium", "high"]),
  kind: z.enum(["verified", "inferred"]),
  explanation: z.string().max(500),
  evidenceIds: z.array(z.string()),
  affectedPackages: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
});

export const recommendedTestSchema = z.object({
  testId: z.string(),
  reason: z.string().max(300),
});

export const aiPackageReportSchema = z.object({
  summary: z.string().max(400),
  riskLevel: z.enum(["none", "low", "medium", "high"]),
  findings: z.array(findingSchema).max(6),
  recommendedTests: z.array(recommendedTestSchema).max(6),
  uncertainties: z.array(z.string().max(200)),
});

export type Finding = z.infer<typeof findingSchema>;
export type RecommendedTest = z.infer<typeof recommendedTestSchema>;
export type AiPackageReport = z.infer<typeof aiPackageReportSchema>;

/**
 * Equivalent plain JSON Schema for LLM structured output.
 */
export const aiPackageReportJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Brief summary of impact (max 400 chars)",
    },
    riskLevel: {
      type: "string",
      enum: ["none", "low", "medium", "high"],
    },
    findings: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          kind: { type: "string", enum: ["verified", "inferred"] },
          explanation: { type: "string" },
          evidenceIds: {
            type: "array",
            items: { type: "string" },
          },
          affectedPackages: {
            type: "array",
            items: { type: "string" },
          },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: [
          "title",
          "severity",
          "kind",
          "explanation",
          "evidenceIds",
          "affectedPackages",
          "confidence",
        ],
      },
    },
    recommendedTests: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          testId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["testId", "reason"],
      },
    },
    uncertainties: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "summary",
    "riskLevel",
    "findings",
    "recommendedTests",
    "uncertainties",
  ],
};
