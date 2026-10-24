import { getStatus, type StatusEntry } from "./git.js";
import { mapFileToPackage, type Package } from "./workspace.js";

export interface FileStatus {
  path: string;
  status: string; // "M" | "A" | "D" | "R" | "?"
  origPath?: string;
}

export interface PackageStatusGroup {
  packageName: string;
  dir: string;
  files: FileStatus[];
}

export interface RepoStatusData {
  isClean: boolean;
  totalFiles: number;
  totalPackages: number;
  hasRootChanges: boolean;
  staged: PackageStatusGroup[];
  unstaged: PackageStatusGroup[];
  untracked: PackageStatusGroup[];
  rawEntries: StatusEntry[];
}

function groupFilesByPackage(
  files: FileStatus[],
  packages: Package[]
): PackageStatusGroup[] {
  const groupsMap = new Map<string, { packageName: string; dir: string; files: FileStatus[] }>();

  for (const file of files) {
    const pkg = mapFileToPackage(file.path, packages);
    const key = pkg ? pkg.name : "(root / unowned)";
    const dir = pkg ? pkg.dir : ".";

    if (!groupsMap.has(key)) {
      groupsMap.set(key, { packageName: key, dir, files: [] });
    }
    groupsMap.get(key)!.files.push(file);
  }

  // Sort groups: workspace packages alphabetically, (root / unowned) at the end
  const groups = Array.from(groupsMap.values());
  groups.sort((a, b) => {
    if (a.packageName === "(root / unowned)") return 1;
    if (b.packageName === "(root / unowned)") return -1;
    return a.packageName.localeCompare(b.packageName);
  });

  // Sort files within each group
  for (const group of groups) {
    group.files.sort((a, b) => a.path.localeCompare(b.path));
  }

  return groups;
}

/**
 * Computes package-aware Git status grouped into staged, unstaged, and untracked sections.
 */
export async function getRepoStatus(root: string, packages: Package[]): Promise<RepoStatusData> {
  const entries = await getStatus(root);

  if (entries.length === 0) {
    return {
      isClean: true,
      totalFiles: 0,
      totalPackages: 0,
      hasRootChanges: false,
      staged: [],
      unstaged: [],
      untracked: [],
      rawEntries: [],
    };
  }

  const stagedFiles: FileStatus[] = [];
  const unstagedFiles: FileStatus[] = [];
  const untrackedFiles: FileStatus[] = [];

  const uniqueFiles = new Set<string>();
  const changedPackages = new Set<string>();
  let hasRootChanges = false;

  for (const entry of entries) {
    uniqueFiles.add(entry.path);
    const owningPkg = mapFileToPackage(entry.path, packages);
    if (owningPkg) {
      changedPackages.add(owningPkg.name);
    } else {
      hasRootChanges = true;
    }

    // Untracked files
    if (entry.indexStatus === "?" || entry.workTreeStatus === "?") {
      untrackedFiles.push({
        path: entry.path,
        status: "?",
      });
      continue;
    }

    // Staged in index
    if (entry.indexStatus !== " " && entry.indexStatus !== "?") {
      stagedFiles.push({
        path: entry.path,
        status: entry.indexStatus,
        ...(entry.origPath ? { origPath: entry.origPath } : {}),
      });
    }

    // Unstaged in working tree
    if (entry.workTreeStatus !== " " && entry.workTreeStatus !== "?") {
      unstagedFiles.push({
        path: entry.path,
        status: entry.workTreeStatus,
      });
    }
  }

  return {
    isClean: false,
    totalFiles: uniqueFiles.size,
    totalPackages: changedPackages.size,
    hasRootChanges,
    staged: groupFilesByPackage(stagedFiles, packages),
    unstaged: groupFilesByPackage(unstagedFiles, packages),
    untracked: groupFilesByPackage(untrackedFiles, packages),
    rawEntries: entries,
  };
}
