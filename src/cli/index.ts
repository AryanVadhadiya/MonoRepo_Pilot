import { resolve } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import {
  buildEvidence,
  createProvider,
  runAiAnalysis,
  type AiAnalysisResult,
  type EvidenceBundle,
} from "../ai/index.js";
import {
  analyze,
  buildGraph,
  clearCache,
  dependentsOf,
  findPackage,
  getCacheDetails,
  getRepoHistory,
  getRepoStatus,
  indexRepo,
  initRepo,
  loadContext,
  workspaceDepsOf,
} from "../core/index.js";
import {
  renderAnalyze,
  renderCacheStats,
  renderEvidence,
  renderGraph,
  renderHistory,
  renderInit,
  renderStatus,
} from "./render.js";

// Load .env file safely if present (Node.js 20+ feature)
try {
  process.loadEnvFile?.();
} catch {
  // Ignore error if .env does not exist
}

function handleError(err: unknown, isJson: boolean): never {
  const message = err instanceof Error ? err.message : String(err);
  if (isJson) {
    console.error(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(pc.red(`Error: ${message}`));
  }
  process.exit(1);
}

const program = new Command();

program
  .name("repopilot")
  .description("Git-backed, monorepo-native CLI with AI-assisted impact analysis")
  .version("0.1.0", "-v, --version", "Output the current version")
  .option("-C, --cwd <path>", "Run as if started in <path>", process.cwd())
  .option("--json", "Output machine-readable JSON", false);

program
  .command("init")
  .description("Initialize RepoPilot in a Git monorepo and discover workspace packages")
  .action(async (_options, command) => {
    const opts = command.optsWithGlobals();
    const cwd = resolve(process.cwd(), opts.cwd || ".");
    const isJson = Boolean(opts.json);
    try {
      const result = await initRepo(cwd);
      const packagesWithDeps = result.packages.map((pkg) => ({
        pkg,
        deps: workspaceDepsOf(pkg, result.packages),
      }));
      renderInit(result, packagesWithDeps, isJson);
    } catch (err) {
      handleError(err, isJson);
    }
  });

program
  .command("status")
  .description("Show package-aware Git status grouped into staged, unstaged, and untracked changes")
  .action(async (_options, command) => {
    const opts = command.optsWithGlobals();
    const cwd = resolve(process.cwd(), opts.cwd || ".");
    const isJson = Boolean(opts.json);
    try {
      const { root, packages } = await loadContext(cwd);
      const statusData = await getRepoStatus(root, packages);
      renderStatus(statusData, isJson);
    } catch (err) {
      handleError(err, isJson);
    }
  });

program
  .command("history")
  .description("Show Git commit history for a package or the entire repository")
  .option("-p, --package <name|dir>", "Filter history by package name or directory")
  .option("-l, --limit <number>", "Number of commits to show (default: 10)", "10")
  .action(async (_cmdOpts, command) => {
    const opts = command.optsWithGlobals();
    const cwd = resolve(process.cwd(), opts.cwd || ".");
    const isJson = Boolean(opts.json);
    const limit = parseInt(opts.limit, 10) || 10;
    try {
      const { root, packages } = await loadContext(cwd);
      const { pkg, commits } = await getRepoHistory(root, packages, {
        packageName: opts.package,
        limit,
      });
      renderHistory(commits, pkg, isJson);
    } catch (err) {
      handleError(err, isJson);
    }
  });

program
  .command("graph")
  .description("Display the workspace package dependency graph and dependents tree")
  .option("-p, --package <name|dir>", "Show direct and transitive dependents of a package")
  .action(async (_cmdOpts, command) => {
    const opts = command.optsWithGlobals();
    const cwd = resolve(process.cwd(), opts.cwd || ".");
    const isJson = Boolean(opts.json);
    try {
      const { root, packages } = await loadContext(cwd);
      const { index } = await indexRepo(root, packages);
      const graph = buildGraph(packages, index);

      if (opts.package) {
        const targetPkg = findPackage(opts.package, packages);
        if (!targetPkg) {
          const validNames = packages.map((p) => p.name).join(", ");
          throw new Error(`Unknown package "${opts.package}". Valid packages: ${validNames}`);
        }
        const dependentsResult = dependentsOf(graph, targetPkg.name);
        renderGraph(graph, targetPkg, dependentsResult, isJson);
      } else {
        renderGraph(graph, null, null, isJson);
      }
    } catch (err) {
      handleError(err, isJson);
    }
  });

program
  .command("analyze")
  .description("Perform deterministic impact analysis, export diffing, and test recommendations")
  .option("--staged", "Analyze staged changes only")
  .option("--base <rev>", "Diff base revision against working tree")
  .option("--ai", "Enable AI impact explanation and ranking", false)
  .option("--refresh", "Bypass AI cache and recompute reports", false)
  .option("--provider <p>", "LLM provider name (e.g. gemini, mock)")
  .option("--model <m>", "LLM model name")
  .option("--show-evidence", "Display gathered evidence bundles and exit without calling model", false)
  .action(async (_cmdOpts, command) => {
    const opts = command.optsWithGlobals();
    const cwd = resolve(process.cwd(), opts.cwd || ".");
    const isJson = Boolean(opts.json);
    try {
      const context = await loadContext(cwd);
      const result = await analyze(context, {
        staged: opts.staged,
        base: opts.base,
      });

      // 1. Dry run / privacy demo: --show-evidence
      if (opts.showEvidence) {
        const bundles: EvidenceBundle[] = [];
        for (const pkg of result.changedPackages) {
          bundles.push(await buildEvidence(context, result, pkg));
        }
        if (isJson) {
          console.log(JSON.stringify(bundles, null, 2));
        } else {
          renderEvidence(bundles);
        }
        return;
      }

      // 2. Opt-in AI analysis: --ai
      let aiResult: AiAnalysisResult | undefined;
      if (opts.ai) {
        if (result.changedPackages.length > 0) {
          const provider = createProvider({
            provider: opts.provider,
            model: opts.model,
          });

          // Compute bounded evidence summary line
          let totalItems = 0;
          let totalChars = 0;
          for (const pkg of result.changedPackages) {
            const b = await buildEvidence(context, result, pkg);
            totalItems += b.items.length;
            totalChars += b.totalChars;
          }

          if (!isJson) {
            console.log(
              pc.dim(
                `Sending bounded evidence (${totalItems} items, ~${totalChars} chars) for ${result.changedPackages.length} package(s) to ${provider.name}:${provider.model}. Excludes .env/keys.\n`
              )
            );
          }

          aiResult = await runAiAnalysis(context, result, provider, {
            refresh: Boolean(opts.refresh),
            providerName: opts.provider,
            modelName: opts.model,
          });
        }
      }

      renderAnalyze(result, aiResult, isJson);
    } catch (err) {
      handleError(err, isJson);
    }
  });

const cacheCommand = program
  .command("cache")
  .description("Inspect or manage RepoPilot incremental index cache");

cacheCommand
  .command("stats")
  .description("Show cache statistics and index size from the last run")
  .action(async (_cmdOpts, command) => {
    const opts = command.optsWithGlobals();
    const cwd = resolve(process.cwd(), opts.cwd || ".");
    const isJson = Boolean(opts.json);
    try {
      const { root } = await loadContext(cwd);
      const details = getCacheDetails(root);
      renderCacheStats(details, isJson);
    } catch (err) {
      handleError(err, isJson);
    }
  });

cacheCommand
  .command("clear")
  .description("Clear index and stats cache files")
  .action(async (_cmdOpts, command) => {
    const opts = command.optsWithGlobals();
    const cwd = resolve(process.cwd(), opts.cwd || ".");
    const isJson = Boolean(opts.json);
    try {
      const { root } = await loadContext(cwd);
      const result = clearCache(root);
      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log("Cleared RepoPilot index and stats cache.");
      }
    } catch (err) {
      handleError(err, isJson);
    }
  });

program.parse(process.argv);
