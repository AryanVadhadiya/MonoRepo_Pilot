import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

export const SCHEMA_VERSION = 1;
export const PARSER_VERSION = "1";

export interface ImportRef {
  specifier: string;
  line?: number;
}

export interface FileIndexEntry {
  sha256: string;
  size: number;
  mtimeMs: number;
  pkg: string | null;
  imports: ImportRef[];
}

export interface RepoIndex {
  schemaVersion: 1;
  parserVersion: "1";
  files: Record<string, FileIndexEntry>;
}

export interface CacheStats {
  filesTotal: number;
  filesHashed: number;
  filesReparsed: number;
  filesReused: number;
  filesRemoved: number;
  durationMs: number;
}

export function createEmptyIndex(): RepoIndex {
  return {
    schemaVersion: SCHEMA_VERSION,
    parserVersion: PARSER_VERSION,
    files: {},
  };
}

/**
 * Loads the cached index from <root>/.repopilot/index.json.
 * If corrupt or version mismatched, discards it and returns an empty index.
 */
export function loadIndex(root: string): RepoIndex {
  const indexPath = resolve(root, ".repopilot", "index.json");
  if (!existsSync(indexPath)) {
    return createEmptyIndex();
  }

  try {
    const raw = readFileSync(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      parsed.schemaVersion === SCHEMA_VERSION &&
      parsed.parserVersion === PARSER_VERSION &&
      typeof parsed.files === "object" &&
      parsed.files !== null
    ) {
      return parsed as RepoIndex;
    }
  } catch {
    // Ignore corruption and rebuild index
  }

  return createEmptyIndex();
}

/**
 * Atomically writes the repo index to <root>/.repopilot/index.json via a temporary file.
 */
export function saveIndex(root: string, index: RepoIndex): void {
  const repopilotDir = resolve(root, ".repopilot");
  mkdirSync(repopilotDir, { recursive: true });

  const indexPath = resolve(repopilotDir, "index.json");
  const tempPath = resolve(
    repopilotDir,
    `index.json.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  );

  writeFileSync(tempPath, JSON.stringify(index, null, 2) + "\n", "utf8");
  renameSync(tempPath, indexPath);
}

/**
 * Loads the last run's CacheStats from .repopilot/stats.json.
 */
export function loadStats(root: string): CacheStats | null {
  const statsPath = resolve(root, ".repopilot", "stats.json");
  if (!existsSync(statsPath)) {
    return null;
  }
  try {
    const raw = readFileSync(statsPath, "utf8");
    return JSON.parse(raw) as CacheStats;
  } catch {
    return null;
  }
}

/**
 * Persists CacheStats to <root>/.repopilot/stats.json.
 */
export function saveStats(root: string, stats: CacheStats): void {
  const repopilotDir = resolve(root, ".repopilot");
  mkdirSync(repopilotDir, { recursive: true });
  const statsPath = resolve(repopilotDir, "stats.json");
  writeFileSync(statsPath, JSON.stringify(stats, null, 2) + "\n", "utf8");
}

/**
 * Clears cached index and stats, keeping config.json intact.
 */
export function clearCache(root: string): { indexDeleted: boolean; statsDeleted: boolean } {
  const repopilotDir = resolve(root, ".repopilot");
  const indexPath = resolve(repopilotDir, "index.json");
  const statsPath = resolve(repopilotDir, "stats.json");

  let indexDeleted = false;
  let statsDeleted = false;

  if (existsSync(indexPath)) {
    rmSync(indexPath, { force: true });
    indexDeleted = true;
  }
  if (existsSync(statsPath)) {
    rmSync(statsPath, { force: true });
    statsDeleted = true;
  }

  return { indexDeleted, statsDeleted };
}

/**
 * Retrieves details for `repopilot cache stats`.
 */
export function getCacheDetails(root: string): {
  stats: CacheStats | null;
  indexSizeBytes: number;
  fileCount: number;
  aiCacheCount: number;
  aiStats: Record<string, unknown> | null;
} {
  const repopilotDir = resolve(root, ".repopilot");
  const indexPath = resolve(repopilotDir, "index.json");
  let indexSizeBytes = 0;
  let fileCount = 0;

  if (existsSync(indexPath)) {
    try {
      const stat = statSync(indexPath);
      indexSizeBytes = stat.size;
      const index = loadIndex(root);
      fileCount = Object.keys(index.files).length;
    } catch {
      // Ignore
    }
  }

  // AI cache count
  let aiCacheCount = 0;
  const aiDir = resolve(repopilotDir, "ai");
  if (existsSync(aiDir)) {
    try {
      const entries = readdirSync(aiDir);
      aiCacheCount = entries.filter((e) => e.endsWith(".json")).length;
    } catch {
      // Ignore
    }
  }

  // Last AI run stats
  let aiStats: Record<string, unknown> | null = null;
  const aiStatsPath = resolve(repopilotDir, "ai-stats.json");
  if (existsSync(aiStatsPath)) {
    try {
      aiStats = JSON.parse(readFileSync(aiStatsPath, "utf8"));
    } catch {
      // Ignore
    }
  }

  const stats = loadStats(root);
  return { stats, indexSizeBytes, fileCount, aiCacheCount, aiStats };
}

