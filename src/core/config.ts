import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getRepoRoot, isGitRepo } from "./git.js";
import { discoverWorkspaces, type Package } from "./workspace.js";

export interface RepopilotConfig {
  schemaVersion: number;
  createdAt: string;
  aiEnabled: boolean;
}

export interface RepoContext {
  root: string;
  packages: Package[];
  config: RepopilotConfig;
}

export interface InitResult {
  root: string;
  packages: Package[];
  config: RepopilotConfig;
  alreadyInitialized: boolean;
}

/**
 * Initializes Repopilot in a Git repository containing workspaces.
 * Creates .repopilot/config.json and ensures .repopilot/ is in .git/info/exclude.
 */
export async function initRepo(cwd: string): Promise<InitResult> {
  const inGit = await isGitRepo(cwd);
  if (!inGit) {
    throw new Error("Cannot initialize: directory is not a Git repository.");
  }

  const root = await getRepoRoot(cwd);
  const packages = await discoverWorkspaces(root);
  if (packages.length === 0) {
    throw new Error("Cannot initialize: no workspaces found in root package.json.");
  }

  const repopilotDir = resolve(root, ".repopilot");
  mkdirSync(repopilotDir, { recursive: true });

  const configPath = resolve(repopilotDir, "config.json");
  let alreadyInitialized = false;
  let config: RepopilotConfig;

  if (existsSync(configPath)) {
    alreadyInitialized = true;
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      config = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        aiEnabled: false,
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    }
  } else {
    config = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      aiEnabled: false,
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  }

  // Ensure .repopilot/ is ignored in .git/info/exclude (never edit tracked .gitignore)
  const gitInfoDir = resolve(root, ".git", "info");
  mkdirSync(gitInfoDir, { recursive: true });
  const excludePath = resolve(gitInfoDir, "exclude");
  let excludeContent = "";
  if (existsSync(excludePath)) {
    excludeContent = readFileSync(excludePath, "utf8");
  }

  const lines = excludeContent.split(/\r?\n/).map((l) => l.trim());
  const hasExclude = lines.some((l) => l === ".repopilot/" || l === ".repopilot");
  if (!hasExclude) {
    const trailingNewline = excludeContent.length === 0 || excludeContent.endsWith("\n") ? "" : "\n";
    writeFileSync(excludePath, `${excludeContent}${trailingNewline}.repopilot/\n`, "utf8");
  }

  return { root, packages, config, alreadyInitialized };
}

/**
 * Shared helper for all repo-aware commands.
 * Fails with "Run `repopilot init` first" if .repopilot/config.json is missing.
 */
export async function loadContext(cwd: string): Promise<RepoContext> {
  const inGit = await isGitRepo(cwd);
  if (!inGit) {
    throw new Error("Not inside a Git repository.");
  }

  const root = await getRepoRoot(cwd);
  const configPath = resolve(root, ".repopilot", "config.json");
  if (!existsSync(configPath)) {
    throw new Error("Run `repopilot init` first");
  }

  let config: RepopilotConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`Corrupt .repopilot/config.json: ${(err as Error).message}. Try running \`repopilot init\` again.`);
  }

  const packages = await discoverWorkspaces(root);
  return { root, packages, config };
}
