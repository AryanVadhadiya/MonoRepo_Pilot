import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024; // 64MB

export interface StatusEntry {
  path: string;
  indexStatus: string;
  workTreeStatus: string;
  origPath?: string;
}

export interface CommitLog {
  sha: string;
  shortSha: string;
  date: string;
  author: string;
  subject: string;
}

export interface DiffOptions {
  staged?: boolean;
  paths?: string[];
}

export interface LogOptions {
  path?: string;
  limit?: number;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
    });
    return stdout;
  } catch (err: unknown) {
    const error = err as { message: string; stderr?: string; stdout?: string; code?: number };
    const stderr = error.stderr ? `\nStderr: ${error.stderr.trim()}` : "";
    throw new Error(`Git command failed: "git ${args.join(" ")}" in "${cwd}"${stderr}\n${error.message}`);
  }
}

/**
 * Checks whether the specified directory is inside a Git repository work tree.
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Returns the absolute path to the root of the Git repository.
 */
export async function getRepoRoot(cwd: string): Promise<string> {
  const out = await runGit(["rev-parse", "--show-toplevel"], cwd);
  return out.trim();
}

/**
 * Returns the current HEAD commit SHA, or null if no commits exist yet.
 */
export async function getHeadSha(root: string): Promise<string | null> {
  try {
    const out = await runGit(["rev-parse", "HEAD"], root);
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Returns parsed status entries from `git status --porcelain=v1 -z`.
 */
export async function getStatus(root: string): Promise<StatusEntry[]> {
  const raw = await runGit(["status", "--porcelain=v1", "-z"], root);
  const parts = raw.split("\0");
  const entries: StatusEntry[] = [];

  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (!item) continue;

    const indexStatus = item[0] ?? " ";
    const workTreeStatus = item[1] ?? " ";
    const path = item.slice(3);

    let origPath: string | undefined;
    if (indexStatus === "R" || indexStatus === "C" || workTreeStatus === "R") {
      i++;
      origPath = parts[i];
    }

    entries.push({
      path,
      indexStatus,
      workTreeStatus,
      ...(origPath ? { origPath } : {}),
    });
  }

  return entries;
}

/**
 * Returns git diff text for working tree or staged changes, optionally filtered by paths.
 */
export async function getDiff(root: string, options?: DiffOptions): Promise<string> {
  const args = ["diff"];
  if (options?.staged) {
    args.push("--staged");
  }
  if (options?.paths && options.paths.length > 0) {
    args.push("--", ...options.paths);
  }
  return runGit(args, root);
}

/**
 * Returns the content of a file at a specific Git revision, or null if it doesn't exist.
 */
export async function showFile(root: string, rev: string, path: string): Promise<string | null> {
  try {
    return await runGit(["show", `${rev}:${path}`], root);
  } catch {
    return null;
  }
}

/**
 * Delimiter-safe git log parser using ASCII record (0x1e) and unit (0x1f) separators.
 */
export async function getLog(root: string, options?: LogOptions): Promise<CommitLog[]> {
  const args = ["log", "--format=%H%x1f%h%x1f%as%x1f%an%x1f%s%x1e"];
  if (options?.limit && options.limit > 0) {
    args.push("-n", String(options.limit));
  }
  if (options?.path) {
    args.push("--", options.path);
  }

  try {
    const raw = await runGit(args, root);
    const records = raw.split("\x1e").filter((r) => r.trim().length > 0);
    return records.map((record) => {
      const [sha = "", shortSha = "", date = "", author = "", subject = ""] = record
        .trim()
        .split("\x1f");
      return { sha, shortSha, date, author, subject };
    });
  } catch {
    return [];
  }
}

/**
 * Returns the list of changed file paths between two Git revisions.
 */
export async function getChangedFilesBetween(
  root: string,
  revA: string,
  revB: string
): Promise<string[]> {
  const raw = await runGit(["diff", "--name-only", "-z", revA, revB], root);
  return raw.split("\0").filter((f) => f.length > 0);
}

/**
 * Returns tracked and untracked (non-ignored) source files matching supported code extensions.
 */
export async function getSourceFiles(root: string): Promise<string[]> {
  const raw = await runGit(["ls-files", "-co", "--exclude-standard", "-z"], root);
  const files = raw.split("\0").filter((f) => f.length > 0);
  const codeExtRegex = /\.(?:[cm]?[jt]sx?)$/i;
  const ignoreDirRegex = /(?:^|\/)(?:node_modules|dist|build|\.repopilot)(?:\/|$)/;

  return files.filter((f) => codeExtRegex.test(f) && !ignoreDirRegex.test(f));
}

