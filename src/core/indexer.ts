import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import {
  loadIndex,
  saveIndex,
  saveStats,
  SCHEMA_VERSION,
  PARSER_VERSION,
  type CacheStats,
  type FileIndexEntry,
  type ImportRef,
  type RepoIndex,
} from "./cache.js";
import { getSourceFiles } from "./git.js";
import { mapFileToPackage, type Package } from "./workspace.js";

/**
 * Extracts import/export/require specifiers from source text using ts.preProcessFile.
 */
export function extractImports(source: string): ImportRef[] {
  const processed = ts.preProcessFile(source, true, true);
  return processed.importedFiles.map((item) => ({
    specifier: item.fileName,
    line: source.slice(0, item.pos).split("\n").length,
  }));
}

/**
 * Indexes repository source files incrementally using cache verification (size, mtime, sha256).
 */
export async function indexRepo(
  root: string,
  packages: Package[]
): Promise<{ index: RepoIndex; stats: CacheStats }> {
  const startTime = Date.now();
  const cachedIndex = loadIndex(root);
  const sourceFiles = await getSourceFiles(root);

  let filesHashed = 0;
  let filesReparsed = 0;
  let filesReused = 0;

  const currentFilesSet = new Set(sourceFiles);
  let filesRemoved = 0;

  for (const cachedPath of Object.keys(cachedIndex.files)) {
    if (!currentFilesSet.has(cachedPath)) {
      filesRemoved++;
    }
  }

  const updatedFiles: Record<string, FileIndexEntry> = {};

  for (const relPath of sourceFiles) {
    const absPath = resolve(root, relPath);
    let size = 0;
    let mtimeMs = 0;

    try {
      const st = statSync(absPath);
      size = st.size;
      mtimeMs = Math.round(st.mtimeMs);
    } catch {
      continue;
    }

    const cached = cachedIndex.files[relPath];

    // Incremental Rule 1: size and mtime match -> reuse without rehashing
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
      updatedFiles[relPath] = cached;
      filesReused++;
      continue;
    }

    // Incremental Rule 2: mtime or size differed -> read and sha256
    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    const hash = createHash("sha256").update(content).digest("hex");
    filesHashed++;

    // Incremental Rule 2a: hash equals cached hash -> only update mtime/size (hashed, NOT reparsed)
    if (cached && cached.sha256 === hash) {
      updatedFiles[relPath] = {
        ...cached,
        size,
        mtimeMs,
      };
      continue;
    }

    // Incremental Rule 2b: hash differed or new file -> re-extract imports (hashed + reparsed)
    filesReparsed++;
    const imports = extractImports(content);
    const owningPkg = mapFileToPackage(relPath, packages);

    updatedFiles[relPath] = {
      sha256: hash,
      size,
      mtimeMs,
      pkg: owningPkg?.name ?? null,
      imports,
    };
  }

  const durationMs = Date.now() - startTime;
  const stats: CacheStats = {
    filesTotal: sourceFiles.length,
    filesHashed,
    filesReparsed,
    filesReused,
    filesRemoved,
    durationMs,
  };

  const newIndex: RepoIndex = {
    schemaVersion: SCHEMA_VERSION,
    parserVersion: PARSER_VERSION,
    files: updatedFiles,
  };

  saveIndex(root, newIndex);
  saveStats(root, stats);

  return { index: newIndex, stats };
}
