import pc from "picocolors";
import type { EvidenceBundle } from "../ai/evidence.js";
import type { AiAnalysisResult } from "../ai/pipeline.js";
import type {
  AnalysisResult,
  CacheStats,
  CommitLog,
  DependencyGraph,
  DependentsResult,
  InitResult,
  Package,
  RepoStatusData,
} from "../core/index.js";

/**
 * Pads a string to a minimum width for aligned table columns.
 */
function pad(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

/**
 * Returns a colored status marker for Git file changes.
 */
function formatMarker(status: string): string {
  switch (status.toUpperCase()) {
    case "M":
      return pc.yellow("M");
    case "A":
      return pc.green("A");
    case "D":
      return pc.red("D");
    case "R":
      return pc.cyan("R");
    case "?":
      return pc.magenta("?");
    default:
      return pc.white(status);
  }
}

/**
 * Renders the result of `repopilot init`.
 */
export function renderInit(
  result: InitResult,
  packagesWithDeps: { pkg: Package; deps: Package[] }[],
  json = false
): void {
  if (json) {
    const jsonOutput = {
      root: result.root,
      alreadyInitialized: result.alreadyInitialized,
      config: result.config,
      packages: packagesWithDeps.map(({ pkg, deps }) => ({
        name: pkg.name,
        dir: pkg.dir,
        version: pkg.version,
        entry: pkg.entry,
        workspaceDepsCount: deps.length,
        workspaceDeps: deps.map((d) => d.name),
      })),
    };
    console.log(JSON.stringify(jsonOutput, null, 2));
    return;
  }

  if (result.alreadyInitialized) {
    console.log(pc.cyan(`RepoPilot already initialized in ${result.root}`));
  } else {
    console.log(pc.green(`✔ Initialized RepoPilot in ${result.root}`));
  }

  console.log(`\nDiscovered ${pc.bold(String(packagesWithDeps.length))} workspace packages:\n`);

  const maxNameLen = Math.max("Package".length, ...packagesWithDeps.map((p) => p.pkg.name.length));
  const maxDirLen = Math.max("Directory".length, ...packagesWithDeps.map((p) => p.pkg.dir.length));

  console.log(
    `  ${pc.bold(pad("Package", maxNameLen))}   ${pc.bold(pad("Directory", maxDirLen))}   ${pc.bold("Workspace Deps")}`
  );
  console.log(
    `  ${pc.dim("─".repeat(maxNameLen))}   ${pc.dim("─".repeat(maxDirLen))}   ${pc.dim("─".repeat(16))}`
  );

  for (const { pkg, deps } of packagesWithDeps) {
    const depsStr =
      deps.length > 0
        ? `${deps.length} (${deps.map((d) => d.name).join(", ")})`
        : "0";
    console.log(
      `  ${pc.cyan(pad(pkg.name, maxNameLen))}   ${pc.dim(pad(pkg.dir, maxDirLen))}   ${deps.length > 0 ? pc.yellow(depsStr) : pc.dim(depsStr)}`
    );
  }
  console.log();
}

/**
 * Renders package-aware Git status.
 */
export function renderStatus(data: RepoStatusData, json = false): void {
  if (json) {
    const jsonOutput = {
      isClean: data.isClean,
      summary: {
        filesChanged: data.totalFiles,
        packagesChanged: data.totalPackages,
        hasRootChanges: data.hasRootChanges,
      },
      staged: data.staged,
      unstaged: data.unstaged,
      untracked: data.untracked,
    };
    console.log(JSON.stringify(jsonOutput, null, 2));
    return;
  }

  if (data.isClean) {
    console.log("Working tree clean");
    return;
  }

  const renderSection = (title: string, colorFn: (s: string) => string, groups: typeof data.staged) => {
    if (groups.length === 0) return;

    console.log(colorFn(title));
    for (const group of groups) {
      if (group.packageName === "(root / unowned)") {
        console.log(`  ${pc.dim("(root / unowned)")}`);
      } else {
        console.log(`  ${pc.bold(group.packageName)} ${pc.dim(`(${group.dir})`)}`);
      }
      for (const file of group.files) {
        const marker = formatMarker(file.status);
        if (file.origPath) {
          console.log(`    ${marker} ${file.origPath} -> ${file.path}`);
        } else {
          console.log(`    ${marker} ${file.path}`);
        }
      }
    }
    console.log();
  };

  renderSection("Staged:", pc.green, data.staged);
  renderSection("Unstaged:", pc.yellow, data.unstaged);
  renderSection("Untracked:", pc.magenta, data.untracked);

  const fileWord = data.totalFiles === 1 ? "file" : "files";
  const pkgWord = data.totalPackages === 1 ? "package" : "packages";
  console.log(`${data.totalFiles} ${fileWord} changed in ${data.totalPackages} ${pkgWord}`);
}

/**
 * Renders Git commit history table.
 */
export function renderHistory(
  commits: CommitLog[],
  pkg: Package | null,
  json = false
): void {
  if (json) {
    const jsonOutput = {
      package: pkg ? { name: pkg.name, dir: pkg.dir } : null,
      commits,
    };
    console.log(JSON.stringify(jsonOutput, null, 2));
    return;
  }

  if (pkg) {
    console.log(`Commit history for ${pc.bold(pc.cyan(pkg.name))} ${pc.dim(`(${pkg.dir})`)}:\n`);
  } else {
    console.log(`Repository commit history:\n`);
  }

  if (commits.length === 0) {
    console.log(pc.dim("  No commits found."));
    return;
  }

  const maxShaLen = Math.max("SHA".length, ...commits.map((c) => c.shortSha.length));
  const maxDateLen = Math.max("Date".length, ...commits.map((c) => c.date.length));
  const maxAuthorLen = Math.max("Author".length, ...commits.map((c) => c.author.length));

  console.log(
    `  ${pc.bold(pad("SHA", maxShaLen))}   ${pc.bold(pad("Date", maxDateLen))}   ${pc.bold(pad("Author", maxAuthorLen))}   ${pc.bold("Subject")}`
  );
  console.log(
    `  ${pc.dim("─".repeat(maxShaLen))}   ${pc.dim("─".repeat(maxDateLen))}   ${pc.dim("─".repeat(maxAuthorLen))}   ${pc.dim("─".repeat(20))}`
  );

  for (const c of commits) {
    console.log(
      `  ${pc.yellow(pad(c.shortSha, maxShaLen))}   ${pc.dim(pad(c.date, maxDateLen))}   ${pc.cyan(pad(c.author, maxAuthorLen))}   ${c.subject}`
    );
  }
  console.log();
}

/**
 * Renders package dependency graph or package dependents tree.
 */
export function renderGraph(
  graph: DependencyGraph,
  targetPkg?: Package | null,
  dependentsResult?: DependentsResult | null,
  json = false
): void {
  if (json) {
    const jsonOutput = {
      graphVersion: graph.graphVersion,
      packages: Object.values(graph.packages).map((p) => ({
        name: p.name,
        dir: p.dir,
        version: p.version,
      })),
      edges: graph.edges,
      hygieneWarnings: graph.hygieneWarnings,
      ...(targetPkg && dependentsResult
        ? {
            targetPackage: { name: targetPkg.name, dir: targetPkg.dir },
            dependents: dependentsResult,
          }
        : {}),
    };
    console.log(JSON.stringify(jsonOutput, null, 2));
    return;
  }

  // 1. Package-filtered view: Dependents of target package
  if (targetPkg && dependentsResult) {
    console.log(
      `Dependents of ${pc.bold(pc.cyan(targetPkg.name))} ${pc.dim(`(${targetPkg.dir})`)}:\n`
    );

    console.log(pc.bold(`Direct Dependents (${dependentsResult.direct.length}):`));
    if (dependentsResult.direct.length === 0) {
      console.log(pc.dim("  (none)"));
    } else {
      for (let i = 0; i < dependentsResult.direct.length; i++) {
        const item = dependentsResult.direct[i];
        const isLast = i === dependentsResult.direct.length - 1;
        const branch = isLast ? "└──" : "├──";
        console.log(`  ${branch} ${pc.cyan(item.name)} ${pc.dim(`[path: ${item.path.join(" -> ")}]`)}`);
      }
    }

    console.log(`\n${pc.bold(`Transitive Dependents (${dependentsResult.transitive.length}):`)}`);
    if (dependentsResult.transitive.length === 0) {
      console.log(pc.dim("  (none)"));
    } else {
      for (let i = 0; i < dependentsResult.transitive.length; i++) {
        const item = dependentsResult.transitive[i];
        const isLast = i === dependentsResult.transitive.length - 1;
        const branch = isLast ? "└──" : "├──";
        console.log(`  ${branch} ${pc.yellow(item.name)} ${pc.dim(`[path: ${item.path.join(" -> ")}]`)}`);
      }
    }

    // Dependencies of target package
    const dependencies = graph.edges
      .filter((e) => e.consumer === targetPkg.name)
      .map((e) => e.dependency);
    console.log(`\n${pc.bold(`Dependencies (${dependencies.length}):`)}`);
    if (dependencies.length === 0) {
      console.log(pc.dim("  (none)"));
    } else {
      for (const dep of dependencies) {
        console.log(`  ├── ${pc.green(dep)}`);
      }
    }
    console.log();
    return;
  }

  // 2. Full Workspace Dependency Graph view
  const packageList = Object.values(graph.packages).sort((a, b) => a.name.localeCompare(b.name));
  console.log(pc.bold(`Workspace Dependency Graph (${packageList.length} packages):\n`));

  for (const pkg of packageList) {
    console.log(`  ${pc.bold(pc.cyan(pkg.name))} ${pc.dim(`(${pkg.dir})`)}`);
    const edges = graph.edges.filter((e) => e.consumer === pkg.name);

    if (edges.length === 0) {
      console.log(pc.dim("    └── (no workspace dependencies)"));
    } else {
      for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];
        const isLast = i === edges.length - 1;
        const branch = isLast ? "└──" : "├──";
        const kinds = edge.evidence.kinds.join(", ");
        let warningFlag = "";
        if (edge.declaredButUnused) warningFlag = pc.yellow(" [declared but unused]");
        if (edge.importedButUndeclared) warningFlag = pc.red(" [imported but undeclared]");

        console.log(
          `    ${branch} ${pc.green(edge.dependency)} ${pc.dim(`[${kinds}]`)}${warningFlag}`
        );
      }
    }
  }

  if (graph.hygieneWarnings.length > 0) {
    console.log(`\n${pc.bold(pc.yellow(`Hygiene Warnings (${graph.hygieneWarnings.length}):`))}`);
    for (const w of graph.hygieneWarnings) {
      console.log(`  ${pc.yellow("⚠")} ${w.message}`);
    }
  }
  console.log();
}

/**
 * Renders evidence bundles for --show-evidence.
 */
export function renderEvidence(bundles: EvidenceBundle[]): void {
  for (const bundle of bundles) {
    console.log(
      pc.bold(
        pc.cyan(
          `\nEvidence Bundle for ${bundle.packageName} (${bundle.items.length} items, ~${bundle.totalChars} chars):`
        )
      )
    );

    for (const item of bundle.items) {
      console.log(`\n  ${pc.bold(pc.yellow(`[${item.id}]`))} ${pc.bold(item.type)}: ${item.label}`);
      console.log(pc.dim("  " + "─".repeat(50)));
      console.log(
        item.text
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")
      );
    }

    if (bundle.tests.length > 0) {
      console.log(pc.bold("\n  Candidate Tests:"));
      for (const t of bundle.tests) {
        console.log(`    ${pc.green(`[${t.id}]`)} ${t.file} ${pc.dim(`(${t.reason})`)}`);
      }
    }

    console.log(
      pc.dim(
        `\n  Budget: ${bundle.totalChars}/${bundle.budgetChars} chars | Truncated: ${bundle.truncated} | Redacted items: ${bundle.redactedItems}`
      )
    );
  }
  console.log();
}

/**
 * Renders the deterministic impact analysis report and optional AI findings.
 */
export function renderAnalyze(
  result: AnalysisResult,
  aiResult?: AiAnalysisResult,
  json = false
): void {
  if (json) {
    const fullJson = {
      ...result,
      ...(aiResult ? { ai: aiResult } : {}),
    };
    console.log(JSON.stringify(fullJson, null, 2));
    return;
  }

  if (result.changedFiles.length === 0) {
    console.log(pc.green("Working tree clean; no changes detected.\n"));
    console.log(
      pc.dim(
        `Index: ${result.stats.filesTotal} files, ${result.stats.filesReused} reused, ${result.stats.filesHashed} hashed, ${result.stats.filesReparsed} reparsed (${result.stats.durationMs} ms)`
      )
    );
    return;
  }

  // Final Risk Header
  const effectiveRisk = aiResult ? aiResult.finalRiskLevel : result.riskLevel;
  const riskColor =
    effectiveRisk === "high"
      ? pc.bgRed(pc.white(pc.bold(" RISK: HIGH ")))
      : effectiveRisk === "medium"
        ? pc.bgYellow(pc.black(pc.bold(" RISK: MEDIUM ")))
        : effectiveRisk === "low"
          ? pc.bgGreen(pc.black(pc.bold(" RISK: LOW ")))
          : pc.bgCyan(pc.black(pc.bold(" RISK: NONE ")));

  const riskLabel = aiResult
    ? `${riskColor} ${pc.dim(`(deterministic: ${result.riskLevel.toUpperCase()}, AI: ${aiResult.aiRiskLevel.toUpperCase()})`)}`
    : riskColor;

  console.log(`\n${riskLabel}\n`);
  for (const reason of result.riskReasons) {
    console.log(`  ${pc.bold("•")} ${reason}`);
  }
  console.log();

  // Changed Packages
  console.log(pc.bold(`Changed Packages (${result.changedPackages.length}):`));
  for (const pkg of result.changedPackages) {
    console.log(`  ${pc.cyan(pkg)}`);
  }
  console.log();

  // Affected Dependents
  const hasDependents = Object.values(result.dependents).some(
    (d) => d.direct.length > 0 || d.transitive.length > 0
  );
  if (hasDependents) {
    console.log(pc.bold("Affected Dependents:"));
    for (const [pkg, depInfo] of Object.entries(result.dependents)) {
      if (depInfo.direct.length === 0 && depInfo.transitive.length === 0) continue;
      console.log(`  ${pc.bold(pkg)}:`);
      for (const d of depInfo.direct) {
        console.log(`    ├── (direct) ${pc.cyan(d.name)} ${pc.dim(`via ${d.path.join(" -> ")}`)}`);
      }
      for (const t of depInfo.transitive) {
        console.log(`    └── (transitive) ${pc.yellow(t.name)} ${pc.dim(`via ${t.path.join(" -> ")}`)}`);
      }
    }
    console.log();
  }

  // Export Surface Changes
  const hasExportDiffs = Object.keys(result.exportDiffs).length > 0;
  if (hasExportDiffs) {
    console.log(pc.bold("Export Surface Changes:"));
    for (const [filePath, diff] of Object.entries(result.exportDiffs)) {
      console.log(`  ${pc.bold(filePath)}:`);
      for (const a of diff.added) {
        console.log(`    ${pc.green(`+ ${a.name} (${a.kind}): ${a.signature}`)}`);
      }
      for (const r of diff.removed) {
        console.log(`    ${pc.red(`- ${r.name} (${r.kind}): ${r.signature}`)}`);
      }
      for (const c of diff.changed) {
        console.log(`    ${pc.yellow(`~ ${c.name} (${c.kind})`)}`);
        console.log(`      ${pc.red(`- ${c.beforeSig}`)}`);
        console.log(`      ${pc.green(`+ ${c.afterSig}`)}`);
      }
    }
    console.log();
  }

  // Breaking Candidates
  if (result.breakingCandidates.length > 0) {
    console.log(pc.bold(pc.red(`Breaking Candidates (${result.breakingCandidates.length}):`)));
    for (const cand of result.breakingCandidates) {
      console.log(
        `  ${pc.bold(pc.yellow(cand.exportName))} ${pc.dim(`(${cand.kind}, ${cand.type} in ${cand.pkg})`)}`
      );
      if (cand.usages.length === 0) {
        console.log(pc.dim("    ↳ (no active workspace call sites found)"));
      } else {
        for (const usage of cand.usages) {
          console.log(`    ${pc.cyan(usage.file)}:${pc.yellow(String(usage.line))}: ${usage.lineText}`);
          if (usage.arityMismatch) {
            console.log(`      ${pc.red(`↳ [${usage.arityMismatch}]`)}`);
          }
        }
      }
    }
    console.log();
  }

  // Candidate Tests
  if (result.candidateTests.length > 0) {
    console.log(pc.bold(`Recommended Candidate Tests (${result.candidateTests.length}):`));
    for (const test of result.candidateTests) {
      console.log(`  ${pc.green("✔")} ${test.file} ${pc.dim(`(${test.reason})`)}`);
    }
    console.log();
  }

  // AI Analysis Section
  if (aiResult) {
    if (aiResult.aiError) {
      console.log(pc.yellow(`\n⚠ AI Analysis Skipped / Failed: ${aiResult.aiError}\n`));
    } else {
      console.log(pc.bold(pc.magenta("══════════════════════════════════════════════════")));
      console.log(pc.bold(pc.magenta("               AI IMPACT EXPLANATION              ")));
      console.log(pc.bold(pc.magenta("══════════════════════════════════════════════════\n")));

      for (const [pkgName, report] of Object.entries(aiResult.reports)) {
        console.log(pc.bold(pc.cyan(`Package: ${pkgName}`)) + (report.fromCache ? pc.dim(" [cached]") : ""));
        console.log(`Summary: ${report.summary}\n`);

        if (report.findings.length > 0) {
          console.log(pc.bold(`Findings (${report.findings.length}):`));
          for (const f of report.findings) {
            const tag =
              f.kind === "verified"
                ? pc.green(pc.bold("[VERIFIED]"))
                : pc.yellow(pc.bold("[INFERRED]"));
            const sev =
              f.severity === "high"
                ? pc.red(f.severity.toUpperCase())
                : f.severity === "medium"
                  ? pc.yellow(f.severity.toUpperCase())
                  : pc.green(f.severity.toUpperCase());
            console.log(`  ${tag} ${sev} ${pc.bold(f.title)}`);
            console.log(`    ${f.explanation}`);
            console.log(
              `    ${pc.dim(`evidence: ${f.evidenceIds.join(", ")} | affected: ${f.affectedPackages.join(", ") || "(none)"} | confidence: ${f.confidence}`)}`
            );
          }
          console.log();
        }

        if (report.recommendedTests.length > 0) {
          console.log(pc.bold("AI Recommended Tests:"));
          for (const t of report.recommendedTests) {
            console.log(`  ${pc.green("✔")} ${pc.cyan(t.testFile)} ${pc.dim(`(${t.reason})`)}`);
          }
          console.log(pc.dim("  Tests were NOT executed. These are recommendations.\n"));
        }

        if (report.uncertainties.length > 0) {
          console.log(pc.bold("Uncertainties:"));
          for (const u of report.uncertainties) {
            console.log(`  ${pc.dim("•")} ${u}`);
          }
          console.log();
        }

        const g = report.grounding;
        const hasGuardrailActions =
          g.droppedFindings > 0 ||
          g.downgradedFindings > 0 ||
          g.droppedEvidenceIds > 0 ||
          g.droppedTests > 0 ||
          g.droppedPackages > 0;

        if (hasGuardrailActions) {
          const parts: string[] = [];
          if (g.droppedFindings > 0) parts.push(`dropped ${g.droppedFindings} finding(s)`);
          if (g.downgradedFindings > 0) parts.push(`downgraded ${g.downgradedFindings}`);
          if (g.droppedEvidenceIds > 0) parts.push(`dropped ${g.droppedEvidenceIds} invalid evidence citation(s)`);
          if (g.droppedTests > 0) parts.push(`dropped ${g.droppedTests} invalid test(s)`);
          if (g.droppedPackages > 0) parts.push(`dropped ${g.droppedPackages} invalid package(s)`);
          console.log(pc.yellow(`  Grounding: ${parts.join(", ")}\n`));
        }
      }

      const st = aiResult.stats;
      console.log(
        pc.dim(
          `AI: ${st.packages} packages, ${st.aiCalls} calls, ${st.cacheHits} cache hits, ${st.repairs} repairs (${st.durationMs} ms) [${st.provider}:${st.model}]`
        )
      );
    }
  }

  // Footer line
  console.log(
    pc.dim(
      `Index: ${result.stats.filesTotal} files, ${result.stats.filesReused} reused, ${result.stats.filesHashed} hashed, ${result.stats.filesReparsed} reparsed (${result.stats.durationMs} ms)`
    )
  );
}

/**
 * Renders cache statistics.
 */
export function renderCacheStats(
  details: {
    stats: CacheStats | null;
    indexSizeBytes: number;
    fileCount: number;
    aiCacheCount: number;
    aiStats: Record<string, unknown> | null;
  },
  json = false
): void {
  if (json) {
    console.log(JSON.stringify(details, null, 2));
    return;
  }

  console.log(pc.bold("RepoPilot Cache Statistics:\n"));
  console.log(`  Indexed Files:    ${pc.cyan(String(details.fileCount))}`);
  console.log(`  Index Disk Size:  ${pc.cyan(String(details.indexSizeBytes))} bytes`);
  console.log(`  AI Cache Entries: ${pc.cyan(String(details.aiCacheCount))}`);

  if (!details.stats) {
    console.log(pc.dim("\n  (No indexing runs recorded yet)"));
  } else {
    const s = details.stats;
    console.log(`\nLast Indexing Run:`);
    console.log(`  Duration:         ${pc.yellow(String(s.durationMs))} ms`);
    console.log(`  Total Files:      ${s.filesTotal}`);
    console.log(`  Reused (Cached):  ${pc.green(String(s.filesReused))}`);
    console.log(`  Hashed:           ${pc.yellow(String(s.filesHashed))}`);
    console.log(`  Reparsed:         ${pc.cyan(String(s.filesReparsed))}`);
    console.log(`  Removed:          ${pc.red(String(s.filesRemoved))}`);
  }

  if (details.aiStats) {
    const ai = details.aiStats as Record<string, unknown>;
    console.log(`\nLast AI Run:`);
    console.log(`  Provider/Model:   ${pc.cyan(String(ai.provider))}:${pc.cyan(String(ai.model))}`);
    console.log(`  Duration:         ${pc.yellow(String(ai.durationMs))} ms`);
    console.log(`  AI Calls:         ${ai.aiCalls}`);
    console.log(`  Cache Hits:       ${pc.green(String(ai.cacheHits))}`);
    console.log(`  Repairs:          ${ai.repairs}`);
  }

  console.log();
}
