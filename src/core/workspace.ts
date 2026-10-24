import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface Package {
  name: string;
  dir: string; // posix path relative to repo root, e.g. "packages/auth"
  version: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  entry: string; // main or "src/index.ts" fallback
  manifestPath: string;
}

/**
 * Expands patterns like "apps/*", "packages/*", and literal directories
 * without external glob dependencies.
 */
function expandPattern(root: string, pattern: string): string[] {
  const normalized = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/");

  let currentDirs: string[] = [""];

  for (const segment of segments) {
    const nextDirs: string[] = [];
    for (const cur of currentDirs) {
      const curAbs = cur ? resolve(root, cur) : root;
      if (!existsSync(curAbs)) continue;

      if (segment === "*") {
        try {
          const entries = readdirSync(curAbs, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (
              entry.name === "node_modules" ||
              entry.name === ".git" ||
              entry.name === ".repopilot" ||
              entry.name.startsWith(".")
            ) {
              continue;
            }
            nextDirs.push(cur ? `${cur}/${entry.name}` : entry.name);
          }
        } catch {
          // Ignore directory access errors
        }
      } else {
        const nextRel = cur ? `${cur}/${segment}` : segment;
        const nextAbs = resolve(root, nextRel);
        if (existsSync(nextAbs) && statSync(nextAbs).isDirectory()) {
          nextDirs.push(nextRel);
        }
      }
    }
    currentDirs = nextDirs;
  }

  return currentDirs;
}

/**
 * Discovers npm workspace packages defined in the root package.json.
 */
export async function discoverWorkspaces(root: string): Promise<Package[]> {
  const rootManifestPath = resolve(root, "package.json");
  if (!existsSync(rootManifestPath)) {
    return [];
  }

  let workspacesPatterns: string[] = [];
  try {
    const rootManifest = JSON.parse(readFileSync(rootManifestPath, "utf8"));
    if (Array.isArray(rootManifest.workspaces)) {
      workspacesPatterns = rootManifest.workspaces;
    } else if (rootManifest.workspaces && Array.isArray(rootManifest.workspaces.packages)) {
      workspacesPatterns = rootManifest.workspaces.packages;
    }
  } catch (err) {
    throw new Error(`Failed to parse root package.json at ${rootManifestPath}: ${(err as Error).message}`);
  }

  if (workspacesPatterns.length === 0) {
    return [];
  }

  const seenDirs = new Set<string>();
  const packages: Package[] = [];

  for (const pattern of workspacesPatterns) {
    const matchedDirs = expandPattern(root, pattern);
    for (const dir of matchedDirs) {
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);

      const manifestPath = resolve(root, dir, "package.json");
      if (!existsSync(manifestPath)) continue;

      try {
        const content = readFileSync(manifestPath, "utf8");
        const json = JSON.parse(content);
        packages.push({
          name: json.name || dir,
          dir: dir.replace(/\\/g, "/"),
          version: json.version || "1.0.0",
          dependencies: json.dependencies || {},
          devDependencies: json.devDependencies || {},
          peerDependencies: json.peerDependencies || {},
          entry: json.main || "src/index.ts",
          manifestPath: manifestPath.replace(/\\/g, "/"),
        });
      } catch (err) {
        throw new Error(`Failed to parse workspace package manifest at ${manifestPath}: ${(err as Error).message}`);
      }
    }
  }

  // Sort deterministically by name
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Matches a repository-relative file path to its owning workspace package using longest directory prefix.
 * Returns null if the file belongs to no workspace package (root / unowned).
 */
export function mapFileToPackage(relPath: string, packages: Package[]): Package | null {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  // Sort packages by dir length descending so deeper packages match first
  const sorted = [...packages].sort((a, b) => b.dir.length - a.dir.length);

  for (const pkg of sorted) {
    if (normalized === pkg.dir || normalized.startsWith(`${pkg.dir}/`)) {
      return pkg;
    }
  }
  return null;
}

/**
 * Finds a package by its name or its relative directory.
 */
export function findPackage(query: string, packages: Package[]): Package | null {
  const clean = query.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return packages.find((pkg) => pkg.name === clean || pkg.dir === clean) ?? null;
}

/**
 * Returns the subset of a package's dependencies that are workspace packages.
 */
export function workspaceDepsOf(pkg: Package, packages: Package[]): Package[] {
  const allDepNames = new Set([
    ...Object.keys(pkg.dependencies),
    ...Object.keys(pkg.devDependencies),
    ...Object.keys(pkg.peerDependencies),
  ]);

  return packages.filter((p) => p.name !== pkg.name && allDepNames.has(p.name));
}
