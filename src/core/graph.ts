import { createHash } from "node:crypto";
import type { RepoIndex } from "./cache.js";
import { workspaceDepsOf, type Package } from "./workspace.js";

export interface EdgeFileRef {
  file: string;
  specifier: string;
  line?: number;
}

export interface EdgeEvidence {
  kinds: Array<"manifest" | "import">;
  files: EdgeFileRef[];
}

export interface DependencyEdge {
  consumer: string;
  dependency: string;
  evidence: EdgeEvidence;
  declaredButUnused: boolean;
  importedButUndeclared: boolean;
}

export interface HygieneWarning {
  consumer: string;
  dependency: string;
  type: "declaredButUnused" | "importedButUndeclared";
  message: string;
}

export interface DependencyGraph {
  packages: Record<string, Package>;
  edges: DependencyEdge[];
  hygieneWarnings: HygieneWarning[];
  graphVersion: string;
}

export interface DependentRef {
  name: string;
  path: string[];
}

export interface DependentsResult {
  direct: DependentRef[];
  transitive: DependentRef[];
}

/**
 * Builds the workspace package dependency graph merging manifest dependencies with code imports.
 */
export function buildGraph(packages: Package[], index: RepoIndex): DependencyGraph {
  const pkgMap: Record<string, Package> = {};
  for (const pkg of packages) {
    pkgMap[pkg.name] = pkg;
  }

  // Map of `${consumer}->${dependency}` -> DependencyEdge
  const edgeMap = new Map<string, DependencyEdge>();

  function getOrCreateEdge(consumer: string, dependency: string): DependencyEdge {
    const key = `${consumer}->${dependency}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, {
        consumer,
        dependency,
        evidence: {
          kinds: [],
          files: [],
        },
        declaredButUnused: false,
        importedButUndeclared: false,
      });
    }
    return edgeMap.get(key)!;
  }

  // 1. Add manifest dependencies
  for (const pkg of packages) {
    const manifestDeps = workspaceDepsOf(pkg, packages);
    for (const dep of manifestDeps) {
      const edge = getOrCreateEdge(pkg.name, dep.name);
      if (!edge.evidence.kinds.includes("manifest")) {
        edge.evidence.kinds.push("manifest");
      }
    }
  }

  // 2. Add code import dependencies from index
  for (const [relPath, fileEntry] of Object.entries(index.files)) {
    const consumerPkgName = fileEntry.pkg;
    if (!consumerPkgName || !pkgMap[consumerPkgName]) {
      continue;
    }

    for (const imp of fileEntry.imports) {
      // Relative imports stay inside the same package
      if (imp.specifier.startsWith("./") || imp.specifier.startsWith("../")) {
        continue;
      }

      // Check if import specifier targets a workspace package
      for (const targetPkg of packages) {
        if (targetPkg.name === consumerPkgName) continue;

        if (
          imp.specifier === targetPkg.name ||
          imp.specifier.startsWith(`${targetPkg.name}/`)
        ) {
          const edge = getOrCreateEdge(consumerPkgName, targetPkg.name);
          if (!edge.evidence.kinds.includes("import")) {
            edge.evidence.kinds.push("import");
          }
          edge.evidence.files.push({
            file: relPath,
            specifier: imp.specifier,
            line: imp.line,
          });
        }
      }
    }
  }

  // 3. Compute hygiene warnings
  const hygieneWarnings: HygieneWarning[] = [];
  const edges = Array.from(edgeMap.values());

  for (const edge of edges) {
    const hasManifest = edge.evidence.kinds.includes("manifest");
    const hasImport = edge.evidence.kinds.includes("import");

    if (hasManifest && !hasImport) {
      edge.declaredButUnused = true;
      hygieneWarnings.push({
        consumer: edge.consumer,
        dependency: edge.dependency,
        type: "declaredButUnused",
        message: `Package "${edge.consumer}" declares dependency on "${edge.dependency}" but never imports it`,
      });
    } else if (hasImport && !hasManifest) {
      edge.importedButUndeclared = true;
      hygieneWarnings.push({
        consumer: edge.consumer,
        dependency: edge.dependency,
        type: "importedButUndeclared",
        message: `Package "${edge.consumer}" imports "${edge.dependency}" but does not declare it in package.json dependencies`,
      });
    }
  }

  // Sort edges deterministically
  edges.sort((a, b) => {
    const cmp = a.consumer.localeCompare(b.consumer);
    return cmp !== 0 ? cmp : a.dependency.localeCompare(b.dependency);
  });

  // 4. Compute graphVersion hash
  const edgeHashContent = edges
    .map(
      (e) =>
        `${e.consumer}->${e.dependency}:${[...e.evidence.kinds].sort().join(",")}`
    )
    .join("\n");
  const graphVersion = createHash("sha256").update(edgeHashContent).digest("hex");

  return {
    packages: pkgMap,
    edges,
    hygieneWarnings,
    graphVersion,
  };
}

/**
 * Traverses the dependency graph in reverse to discover direct and transitive dependents of a package.
 * Returns shortest path for each dependent.
 */
export function dependentsOf(graph: DependencyGraph, pkgName: string): DependentsResult {
  // Build reverse adjacency: dependency -> consumers
  const reverseAdj = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!reverseAdj.has(edge.dependency)) {
      reverseAdj.set(edge.dependency, []);
    }
    reverseAdj.get(edge.dependency)!.push(edge.consumer);
  }

  const direct: DependentRef[] = [];
  const transitive: DependentRef[] = [];

  const visited = new Set<string>([pkgName]);
  // Queue stores [currentNode, pathToPkgName]
  const queue: Array<{ node: string; path: string[] }> = [{ node: pkgName, path: [pkgName] }];

  while (queue.length > 0) {
    const { node, path } = queue.shift()!;
    const consumers = reverseAdj.get(node) || [];

    for (const consumer of consumers) {
      if (visited.has(consumer)) continue;
      visited.add(consumer);

      const consumerPath = [consumer, ...path];
      if (node === pkgName) {
        direct.push({ name: consumer, path: consumerPath });
      } else {
        transitive.push({ name: consumer, path: consumerPath });
      }

      queue.push({ node: consumer, path: consumerPath });
    }
  }

  // Sort for deterministic results
  direct.sort((a, b) => a.name.localeCompare(b.name));
  transitive.sort((a, b) => a.name.localeCompare(b.name));

  return { direct, transitive };
}
