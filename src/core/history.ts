import { getLog, type CommitLog } from "./git.js";
import { findPackage, type Package } from "./workspace.js";

export interface HistoryOptions {
  packageName?: string;
  limit?: number;
}

export interface RepoHistoryResult {
  pkg: Package | null;
  commits: CommitLog[];
}

/**
 * Retrieves commit history for a specific workspace package or for the entire repository.
 */
export async function getRepoHistory(
  root: string,
  packages: Package[],
  options?: HistoryOptions
): Promise<RepoHistoryResult> {
  const limit = options?.limit ?? 10;

  if (options?.packageName) {
    const pkg = findPackage(options.packageName, packages);
    if (!pkg) {
      const validNames = packages.map((p) => p.name).join(", ");
      throw new Error(
        `Unknown package "${options.packageName}". Valid packages: ${validNames}`
      );
    }

    const commits = await getLog(root, { path: pkg.dir, limit });
    return { pkg, commits };
  }

  const commits = await getLog(root, { limit });
  return { pkg: null, commits };
}
