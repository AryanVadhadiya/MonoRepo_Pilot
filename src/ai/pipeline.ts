import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AnalysisResult, RiskLevel } from "../core/analyze.js";
import { PARSER_VERSION, SCHEMA_VERSION } from "../core/cache.js";
import type { RepoContext } from "../core/config.js";
import { buildEvidence, type EvidenceBundle } from "./evidence.js";
import { createProvider } from "./index.js";
import { buildSystemPrompt, buildUserPrompt, PROMPT_VERSION } from "./prompt.js";
import type { LLMProvider } from "./provider.js";
import { parseJsonLoose } from "./provider.js";
import {
  aiPackageReportJsonSchema,
  aiPackageReportSchema,
  type AiPackageReport,
  type Finding,
} from "./schema.js";

export interface GroundingResult {
  droppedFindings: number;
  downgradedFindings: number;
  droppedEvidenceIds: number;
  droppedTests: number;
  droppedPackages: number;
}

export interface GroundedTestItem {
  testId: string;
  testFile: string;
  reason: string;
}

export interface GroundedPackageReport {
  packageName: string;
  summary: string;
  riskLevel: RiskLevel;
  findings: Finding[];
  recommendedTests: GroundedTestItem[];
  uncertainties: string[];
  grounding: GroundingResult;
  bundle: EvidenceBundle;
  fromCache: boolean;
}

export interface AiRunStats {
  packages: number;
  aiCalls: number;
  cacheHits: number;
  skippedNoImpact: number;
  repairs: number;
  fallbacks: number;
  durationMs: number;
  provider: string;
  model: string;
  redactedItems: number;
  truncated: boolean;
}

export interface AiAnalysisResult {
  reports: Record<string, GroundedPackageReport>;
  finalRiskLevel: RiskLevel;
  deterministicRiskLevel: RiskLevel;
  aiRiskLevel: RiskLevel;
  stats: AiRunStats;
  aiError?: string;
}

export interface AiPipelineOptions {
  refresh?: boolean;
  providerName?: string;
  modelName?: string;
}

const RISK_WEIGHTS: Record<RiskLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_WEIGHTS[a] >= RISK_WEIGHTS[b] ? a : b;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Executes a call to the LLM provider with exponential backoff for transient errors.
 */
async function callProviderWithRetry(
  provider: LLMProvider,
  system: string,
  user: string,
  fallbackModel?: string
): Promise<{ rawText: string; usedFallback: boolean }> {
  const retryDelays = [1000, 2000, 4000];
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      const rawText = await provider.generate({
        system,
        user,
        jsonSchema: aiPackageReportJsonSchema,
      });
      return { rawText, usedFallback: false };
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /429|500|503|timeout|UNAVAILABLE|exhausted/i.test(msg);

      if (isTransient && attempt < retryDelays.length) {
        const jitter = Math.floor(Math.random() * 200);
        await sleep(retryDelays[attempt] + jitter);
        continue;
      }
      break;
    }
  }

  // Attempt Fallback Model if configured
  if (fallbackModel && fallbackModel !== provider.model) {
    try {
      const fallbackProvider = createProvider({
        provider: provider.name,
        model: fallbackModel,
      });
      const rawText = await fallbackProvider.generate({
        system,
        user,
        jsonSchema: aiPackageReportJsonSchema,
      });
      return { rawText, usedFallback: true };
    } catch (fallbackErr) {
      lastError = fallbackErr;
    }
  }

  throw lastError;
}

/**
 * Deterministically applies grounding guardrails against the provided evidence bundle.
 */
export function applyGroundingGuardrails(
  rawReport: AiPackageReport,
  bundle: EvidenceBundle,
  validPackageNames: Set<string>
): {
  report: Omit<GroundedPackageReport, "packageName" | "bundle" | "fromCache">;
  grounding: GroundingResult;
} {
  const validEvidenceIds = new Set(bundle.items.map((i) => i.id));
  const verifiedEvidenceIds = new Set(
    bundle.items
      .filter((i) => i.type === "export-change" || i.type === "usage")
      .map((i) => i.id)
  );
  const validTestMap = new Map(bundle.tests.map((t) => [t.id, t.file]));

  let droppedFindings = 0;
  let downgradedFindings = 0;
  let droppedEvidenceIds = 0;
  let droppedTests = 0;
  let droppedPackages = 0;

  const groundedFindings: Finding[] = [];

  for (const finding of rawReport.findings) {
    // 1. Filter Evidence IDs to valid items in bundle
    const groundedEvIds: string[] = [];
    for (const id of finding.evidenceIds) {
      if (validEvidenceIds.has(id)) {
        groundedEvIds.push(id);
      } else {
        droppedEvidenceIds++;
      }
    }

    // Drop finding completely if no valid evidence IDs remain
    if (groundedEvIds.length === 0) {
      droppedFindings++;
      continue;
    }

    // 2. Guardrail: Downgrade "verified" to "inferred" if none of cited evidence is export-change/usage
    let kind = finding.kind;
    if (kind === "verified") {
      const hasVerifiedEvidence = groundedEvIds.some((id) => verifiedEvidenceIds.has(id));
      if (!hasVerifiedEvidence) {
        kind = "inferred";
        downgradedFindings++;
      }
    }

    // 3. Filter affectedPackages to real workspace packages
    const groundedPackages: string[] = [];
    for (const pkg of finding.affectedPackages) {
      if (validPackageNames.has(pkg)) {
        groundedPackages.push(pkg);
      } else {
        droppedPackages++;
      }
    }

    groundedFindings.push({
      ...finding,
      kind,
      evidenceIds: groundedEvIds,
      affectedPackages: groundedPackages,
    });
  }

  // 4. Filter Recommended Tests to valid test IDs in bundle
  const recommendedTests: GroundedTestItem[] = [];
  for (const t of rawReport.recommendedTests) {
    if (validTestMap.has(t.testId)) {
      recommendedTests.push({
        testId: t.testId,
        testFile: validTestMap.get(t.testId)!,
        reason: t.reason,
      });
    } else {
      droppedTests++;
    }
  }

  const grounding: GroundingResult = {
    droppedFindings,
    downgradedFindings,
    droppedEvidenceIds,
    droppedTests,
    droppedPackages,
  };

  return {
    report: {
      summary: rawReport.summary,
      riskLevel: rawReport.riskLevel,
      findings: groundedFindings,
      recommendedTests,
      uncertainties: rawReport.uncertainties,
      grounding,
    },
    grounding,
  };
}

/**
 * Runs the AI impact analysis pipeline across changed workspace packages.
 */
export async function runAiAnalysis(
  ctx: RepoContext,
  analysis: AnalysisResult,
  provider: LLMProvider,
  opts?: AiPipelineOptions
): Promise<AiAnalysisResult> {
  const startTime = Date.now();
  const root = ctx.root;
  const aiCacheDir = resolve(root, ".repopilot", "ai");
  mkdirSync(aiCacheDir, { recursive: true });

  const fallbackModel = process.env.REPOPILOT_FALLBACK_MODEL;
  const validPackageNames = new Set(ctx.packages.map((p) => p.name));

  let aiCalls = 0;
  let cacheHits = 0;
  let skippedNoImpact = 0;
  let repairs = 0;
  let fallbacks = 0;
  let totalRedacted = 0;
  let anyTruncated = false;

  const reports: Record<string, GroundedPackageReport> = {};
  let aiMaxRisk: RiskLevel = "none";

  // Analyze each changed package
  for (const pkgName of analysis.changedPackages) {
    const depInfo = analysis.dependents[pkgName];
    const hasDependents = depInfo && (depInfo.direct.length > 0 || depInfo.transitive.length > 0);
    const hasExportChanges = Object.entries(analysis.exportDiffs).some(([path]) => {
      const f = analysis.changedFiles.find((cf) => cf.path === path);
      return f?.pkg === pkgName;
    });

    // Fast-path: Package has no export modifications and no dependents
    if (!hasDependents && !hasExportChanges) {
      skippedNoImpact++;
      reports[pkgName] = {
        packageName: pkgName,
        summary: `Internal modifications in ${pkgName} with no cross-package impact.`,
        riskLevel: "low",
        findings: [],
        recommendedTests: [],
        uncertainties: [],
        grounding: {
          droppedFindings: 0,
          downgradedFindings: 0,
          droppedEvidenceIds: 0,
          droppedTests: 0,
          droppedPackages: 0,
        },
        bundle: await buildEvidence(ctx, analysis, pkgName),
        fromCache: false,
      };
      aiMaxRisk = maxRisk(aiMaxRisk, "low");
      continue;
    }

    // Build evidence bundle
    const bundle = await buildEvidence(ctx, analysis, pkgName);
    totalRedacted += bundle.redactedItems;
    if (bundle.truncated) anyTruncated = true;

    // Compute Cache Key
    const cacheKeyRaw = JSON.stringify({
      packageName: pkgName,
      bundleContentHash: bundle.contentHash,
      graphVersion: analysis.graphVersion,
      parserVersion: PARSER_VERSION,
      PROMPT_VERSION,
      SCHEMA_VERSION,
      provider: provider.name,
      model: provider.model,
      evidenceChars: bundle.budgetChars,
    });
    const cacheKey = createHash("sha256").update(cacheKeyRaw).digest("hex");
    const cacheFilePath = resolve(aiCacheDir, `${cacheKey}.json`);

    // Check Cache
    if (!opts?.refresh && existsSync(cacheFilePath)) {
      try {
        const cachedRaw = readFileSync(cacheFilePath, "utf8");
        const cachedReport = JSON.parse(cachedRaw) as GroundedPackageReport;
        cacheHits++;
        reports[pkgName] = { ...cachedReport, fromCache: true, bundle };
        aiMaxRisk = maxRisk(aiMaxRisk, cachedReport.riskLevel);
        continue;
      } catch {
        // Corrupt cache file, treat as miss
      }
    }

    // Cache Miss: Run Model Call
    aiCalls++;
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(bundle, analysis.riskLevel, analysis.riskReasons);

    let rawText: string;
    try {
      const callRes = await callProviderWithRetry(
        provider,
        systemPrompt,
        userPrompt,
        fallbackModel
      );
      rawText = callRes.rawText;
      if (callRes.usedFallback) fallbacks++;
    } catch (err) {
      // Graceful error: return partial/deterministic result
      const errorMsg = (err instanceof Error ? err.message : String(err)).replace(
        /key=[A-Za-z0-9_-]+/gi,
        "key=[REDACTED]"
      );
      return {
        reports,
        finalRiskLevel: analysis.riskLevel,
        deterministicRiskLevel: analysis.riskLevel,
        aiRiskLevel: aiMaxRisk,
        stats: {
          packages: analysis.changedPackages.length,
          aiCalls,
          cacheHits,
          skippedNoImpact,
          repairs,
          fallbacks,
          durationMs: Date.now() - startTime,
          provider: provider.name,
          model: provider.model,
          redactedItems: totalRedacted,
          truncated: anyTruncated,
        },
        aiError: errorMsg,
      };
    }

    // Parse JSON
    let parsedJson: unknown;
    try {
      parsedJson = parseJsonLoose(rawText);
    } catch {
      // First parse failed: try repair retry
      repairs++;
      const repairPrompt = `${userPrompt}\n\nYour previous response was not valid JSON. Return ONLY a valid JSON object matching the schema:\n${aiPackageReportJsonSchema}`;
      const repairRes = await callProviderWithRetry(provider, systemPrompt, repairPrompt);
      parsedJson = parseJsonLoose(repairRes.rawText);
    }

    // Validate with Zod Schema
    let validation = aiPackageReportSchema.safeParse(parsedJson);
    if (!validation.success) {
      repairs++;
      const errorSummary = validation.error.issues
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join("; ");
      const repairPrompt = `${userPrompt}\n\nYour response failed schema validation: ${errorSummary}\nReturn ONLY a corrected JSON object matching the schema.`;
      const repairRes = await callProviderWithRetry(provider, systemPrompt, repairPrompt);
      const repairedJson = parseJsonLoose(repairRes.rawText);
      validation = aiPackageReportSchema.safeParse(repairedJson);
      if (!validation.success) {
        throw new Error(`AI response failed schema validation after repair: ${validation.error.message}`);
      }
    }

    // Grounding Check
    const { report: groundedReport, grounding } = applyGroundingGuardrails(
      validation.data,
      bundle,
      validPackageNames
    );

    const fullPackageReport: GroundedPackageReport = {
      packageName: pkgName,
      ...groundedReport,
      grounding,
      bundle,
      fromCache: false,
    };

    // Write to Atomic Cache
    const tempPath = resolve(aiCacheDir, `${cacheKey}.tmp.${process.pid}.${Date.now()}`);
    writeFileSync(tempPath, JSON.stringify(fullPackageReport, null, 2) + "\n", "utf8");
    renameSync(tempPath, cacheFilePath);

    reports[pkgName] = fullPackageReport;
    aiMaxRisk = maxRisk(aiMaxRisk, fullPackageReport.riskLevel);
  }

  const durationMs = Date.now() - startTime;
  const stats: AiRunStats = {
    packages: analysis.changedPackages.length,
    aiCalls,
    cacheHits,
    skippedNoImpact,
    repairs,
    fallbacks,
    durationMs,
    provider: provider.name,
    model: provider.model,
    redactedItems: totalRedacted,
    truncated: anyTruncated,
  };

  // Persist last AI stats
  const repopilotDir = resolve(root, ".repopilot");
  writeFileSync(resolve(repopilotDir, "ai-stats.json"), JSON.stringify(stats, null, 2) + "\n", "utf8");

  // Final risk = max(deterministic, AI)
  const finalRiskLevel = maxRisk(analysis.riskLevel, aiMaxRisk);

  return {
    reports,
    finalRiskLevel,
    deterministicRiskLevel: analysis.riskLevel,
    aiRiskLevel: aiMaxRisk,
    stats,
  };
}
