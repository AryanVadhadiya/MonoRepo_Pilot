import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CacheStats } from "./cache.js";
import type { RepoContext } from "./config.js";
import { diffExports, extractExports, type ExportDiff } from "./exports.js";
import { getChangedFilesBetween, getStatus, showFile } from "./git.js";
import { buildGraph, dependentsOf, type DependentRef } from "./graph.js";
import { indexRepo } from "./indexer.js";
import { mapFileToPackage } from "./workspace.js";

export interface AnalyzeOptions {
  staged?: boolean;
  base?: string;
}

export interface ChangedFileInfo {
  path: string;
  pkg: string | null;
  status: string;
}

export interface BreakingUsage {
  file: string;
  line: number;
  lineText: string;
  arityMismatch?: string; // heuristic explanation if arity differs
}

export interface BreakingCandidate {
  exportName: string;
  kind: string;
  type: "removed" | "changed";
  pkg: string;
  file: string;
  beforeSig?: string;
  afterSig?: string;
  usages: BreakingUsage[];
}

export interface CandidateTest {
  file: string;
  pkg: string | null;
  reason: string;
}

export type RiskLevel = "none" | "low" | "medium" | "high";

export interface AnalysisResult {
  changedFiles: ChangedFileInfo[];
  changedPackages: string[];
  dependents: Record<string, { direct: DependentRef[]; transitive: DependentRef[] }>;
  exportDiffs: Record<string, ExportDiff>;
  breakingCandidates: BreakingCandidate[];
  candidateTests: CandidateTest[];
  riskLevel: RiskLevel;
  riskReasons: string[];
  stats: CacheStats;
  graphVersion: string;
}

/**
 * Counts parameter count from a signature string like "(token: string, strict: boolean): boolean".
 */
function parseParamCount(signature: string): number | null {
  const match = signature.match(/\(([^)]*)\)/);
  if (!match) return null;
  const inside = match[1].trim();
  if (inside.length === 0) return 0;
  // Count commas at top level
  let count = 1;
  let depth = 0;
  for (const ch of inside) {
    if (ch === "(" || ch === "<" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === ">" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

/**
 * Counts call arguments from a line calling `func(...)`.
 */
function parseCallArgCount(line: string, funcName: string): number | null {
  const regex = new RegExp(`\\b${funcName}\\s*\\(([^)]*)\\)`);
  const match = line.match(regex);
  if (!match) return null;
  const args = match[1].trim();
  if (args.length === 0) return 0;
  let count = 1;
  let depth = 0;
  for (const ch of args) {
    if (ch === "(" || ch === "<" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === ">" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

/**
 * Performs monorepo-native impact analysis:
 * incremental indexing, dependency graph traversal, export diffing, usage scanning, and test recommendation.
 */
export async function analyze(
  ctx: RepoContext,
  opts?: AnalyzeOptions
): Promise<AnalysisResult> {
  const root = ctx.root;
  const packages = ctx.packages;

  // 1. Incremental Indexing & Dependency Graph
  const { index, stats } = await indexRepo(root, packages);
  const graph = buildGraph(packages, index);

  // 2. Discover Changed Files
  const changedFilesMap = new Map<string, ChangedFileInfo>();

  if (opts?.base) {
    const rawFiles = await getChangedFilesBetween(root, opts.base, "HEAD");
    for (const file of rawFiles) {
      const owningPkg = mapFileToPackage(file, packages);
      changedFilesMap.set(file, {
        path: file,
        pkg: owningPkg?.name ?? null,
        status: "M",
      });
    }
  } else {
    const statusEntries = await getStatus(root);
    for (const entry of statusEntries) {
      if (opts?.staged) {
        if (entry.indexStatus === " " || entry.indexStatus === "?") continue;
      }
      const owningPkg = mapFileToPackage(entry.path, packages);
      changedFilesMap.set(entry.path, {
        path: entry.path,
        pkg: owningPkg?.name ?? null,
        status: entry.indexStatus !== " " && entry.indexStatus !== "?" ? entry.indexStatus : entry.workTreeStatus,
      });
    }
  }

  const changedFiles = Array.from(changedFilesMap.values());
  const changedPackagesSet = new Set<string>();
  for (const f of changedFiles) {
    if (f.pkg) changedPackagesSet.add(f.pkg);
  }
  const changedPackages = Array.from(changedPackagesSet).sort();

  // 3. Compute Dependents per Changed Package
  const dependents: Record<string, { direct: DependentRef[]; transitive: DependentRef[] }> = {};
  for (const pkgName of changedPackages) {
    dependents[pkgName] = dependentsOf(graph, pkgName);
  }

  // 4. Compute Export Surface Diffs
  const exportDiffs: Record<string, ExportDiff> = {};
  const codeExtRegex = /\.(?:[cm]?[jt]sx?)$/i;

  for (const file of changedFiles) {
    if (!codeExtRegex.test(file.path)) continue;

    const beforeContent = (await showFile(root, opts?.base ?? "HEAD", file.path)) ?? "";
    const fullAfterPath = resolve(root, file.path);
    const afterContent = existsSync(fullAfterPath) ? readFileSync(fullAfterPath, "utf8") : "";

    const beforeExports = extractExports(beforeContent, file.path);
    const afterExports = extractExports(afterContent, file.path);
    const diff = diffExports(beforeExports, afterExports);

    if (diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0) {
      exportDiffs[file.path] = diff;
    }
  }

  // 5. Scan for Breaking Candidate Usages
  const breakingCandidates: BreakingCandidate[] = [];

  for (const [changedPath, diff] of Object.entries(exportDiffs)) {
    const changedFileInfo = changedFilesMap.get(changedPath);
    const changedPkgName = changedFileInfo?.pkg;
    if (!changedPkgName) continue;

    const allDependents = dependents[changedPkgName];
    if (!allDependents) continue;

    const dependentNames = new Set([
      ...allDependents.direct.map((d) => d.name),
      ...allDependents.transitive.map((d) => d.name),
    ]);

    if (dependentNames.size === 0) continue;

    // Dependent source files from the index that import from the changed package
    const candidateConsumerFiles: string[] = [];
    for (const [indexPath, indexEntry] of Object.entries(index.files)) {
      if (!indexEntry.pkg || !dependentNames.has(indexEntry.pkg)) continue;
      const importsFromPkg = indexEntry.imports.some(
        (imp) => imp.specifier === changedPkgName || imp.specifier.startsWith(`${changedPkgName}/`)
      );
      if (importsFromPkg) {
        candidateConsumerFiles.push(indexPath);
      }
    }

    const itemsToScan: Array<{
      name: string;
      kind: string;
      type: "removed" | "changed";
      beforeSig?: string;
      afterSig?: string;
    }> = [
      ...diff.removed.map((r) => ({ name: r.name, kind: r.kind, type: "removed" as const, beforeSig: r.signature })),
      ...diff.changed.map((c) => ({
        name: c.name,
        kind: c.kind,
        type: "changed" as const,
        beforeSig: c.beforeSig,
        afterSig: c.afterSig,
      })),
    ];

    for (const item of itemsToScan) {
      const usages: BreakingUsage[] = [];
      const wordRegex = new RegExp(`\\b${item.name}\\b`);

      const beforeParams = item.beforeSig ? parseParamCount(item.beforeSig) : null;
      const afterParams = item.afterSig ? parseParamCount(item.afterSig) : null;
      const arityChanged =
        item.kind === "function" &&
        beforeParams !== null &&
        afterParams !== null &&
        beforeParams !== afterParams;

      for (const consumerRelPath of candidateConsumerFiles) {
        if (usages.length >= 5) break;
        const consumerAbsPath = resolve(root, consumerRelPath);
        if (!existsSync(consumerAbsPath)) continue;

        const consumerSource = readFileSync(consumerAbsPath, "utf8");
        const lines = consumerSource.split("\n");

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          if (usages.length >= 5) break;
          const lineText = lines[lineIdx];

          // Skip import statements when scanning for consumer usage calls
          if (/^\s*import\b/.test(lineText)) continue;

          if (wordRegex.test(lineText)) {
            let arityMismatch: string | undefined;
            if (arityChanged && afterParams !== null) {
              const callArgCount = parseCallArgCount(lineText, item.name);
              if (callArgCount !== null && callArgCount !== afterParams) {
                arityMismatch = `heuristic: expected ${afterParams} args, called with ${callArgCount}`;
              }
            }

            usages.push({
              file: consumerRelPath,
              line: lineIdx + 1,
              lineText: lineText.trim(),
              ...(arityMismatch ? { arityMismatch } : {}),
            });
          }
        }
      }

      if (usages.length > 0 || item.type === "removed" || item.type === "changed") {
        breakingCandidates.push({
          exportName: item.name,
          kind: item.kind,
          type: item.type,
          pkg: changedPkgName,
          file: changedPath,
          beforeSig: item.beforeSig,
          afterSig: item.afterSig,
          usages,
        });
      }
    }
  }

  // 6. Test Recommendation
  const candidateTests: CandidateTest[] = [];
  const testFileRegex = /(?:^|\/)(?:__tests__\/.*|\S+\.(?:test|spec)\.[cm]?[jt]sx?)$/i;

  for (const [indexPath, indexEntry] of Object.entries(index.files)) {
    if (!testFileRegex.test(indexPath)) continue;

    // In changed package
    if (indexEntry.pkg && changedPackagesSet.has(indexEntry.pkg)) {
      candidateTests.push({
        file: indexPath,
        pkg: indexEntry.pkg,
        reason: "in changed package",
      });
      continue;
    }

    // In dependent package
    for (const changedPkgName of changedPackages) {
      const depInfo = dependents[changedPkgName];
      if (!depInfo) continue;

      const directMatch = depInfo.direct.find((d) => d.name === indexEntry.pkg);
      if (directMatch) {
        candidateTests.push({
          file: indexPath,
          pkg: indexEntry.pkg,
          reason: `in dependent package via ${directMatch.path.join(" -> ")}`,
        });
        break;
      }

      const transitiveMatch = depInfo.transitive.find((d) => d.name === indexEntry.pkg);
      if (transitiveMatch) {
        candidateTests.push({
          file: indexPath,
          pkg: indexEntry.pkg,
          reason: `in dependent package via ${transitiveMatch.path.join(" -> ")}`,
        });
        break;
      }
    }
  }

  candidateTests.sort((a, b) => a.file.localeCompare(b.file));

  // 7. Deterministic Risk Level & Reasons
  let riskLevel: RiskLevel = "none";
  const riskReasons: string[] = [];

  const hasBreakingUsages = breakingCandidates.some((c) => c.usages.length > 0);
  const hasExportModifications = Object.values(exportDiffs).some(
    (d) => d.removed.length > 0 || d.changed.length > 0
  );
  const hasTransitiveDependents = Object.values(dependents).some((d) => d.transitive.length > 0);

  if (changedFiles.length === 0) {
    riskLevel = "none";
    riskReasons.push("Working tree clean; no changes detected.");
  } else if (hasBreakingUsages) {
    riskLevel = "high";
    riskReasons.push(
      "Export surface changed and active usages were found in dependent workspace packages."
    );
  } else if (hasExportModifications || hasTransitiveDependents) {
    riskLevel = "medium";
    if (hasExportModifications) {
      riskReasons.push("Export surface was modified, but no dependent usages were matched.");
    }
    if (hasTransitiveDependents) {
      riskReasons.push("Changes affect packages with transitive dependents.");
    }
  } else {
    riskLevel = "low";
    riskReasons.push("Changes are internal with no detected impact on dependent packages.");
  }

  return {
    changedFiles,
    changedPackages,
    dependents,
    exportDiffs,
    breakingCandidates,
    candidateTests,
    riskLevel,
    riskReasons,
    stats,
    graphVersion: graph.graphVersion,
  };
}
