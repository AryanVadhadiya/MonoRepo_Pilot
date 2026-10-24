import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AnalysisResult } from "../core/analyze.js";
import type { RepoContext } from "../core/config.js";
import { getDiff } from "../core/git.js";

export interface EvidenceItem {
  id: string; // E1, E2, ...
  type: "export-change" | "usage" | "diff" | "dependency-path" | "metadata";
  label: string;
  text: string;
  files?: string[];
}

export interface EvidenceTest {
  id: string; // T1, T2, ...
  file: string;
  pkg: string | null;
  reason: string;
}

export interface EvidenceBundle {
  packageName: string;
  items: EvidenceItem[];
  tests: EvidenceTest[];
  totalChars: number;
  budgetChars: number;
  truncated: boolean;
  droppedItemsCount: number;
  redactedItems: number;
  contentHash: string;
}

const SENSITIVE_FILENAME_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /^id_rsa/i,
  /(?:^|\/)secrets\//i,
  /(?:^|\/)credentials/i,
];

export function isSensitiveFile(filePath: string): boolean {
  const base = filePath.split("/").pop() || filePath;
  return SENSITIVE_FILENAME_PATTERNS.some((p) => p.test(base) || p.test(filePath));
}

export function hasSecretContent(content: string): boolean {
  const secretPatterns = [
    /\b[A-Za-z0-9_]*API[_-]?KEY\s*=/i,
    /\b[A-Za-z0-9_]*SECRET\s*=/i,
    /BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY/i,
    /BEGIN\s+CERTIFICATE/i,
  ];
  return secretPatterns.some((p) => p.test(content));
}

/**
 * Builds a bounded, security-sanitized EvidenceBundle for a single changed package.
 */
export async function buildEvidence(
  ctx: RepoContext,
  analysis: AnalysisResult,
  pkgName: string
): Promise<EvidenceBundle> {
  const root = ctx.root;
  const budgetChars = parseInt(process.env.REPOPILOT_EVIDENCE_CHARS || "12000", 10) || 12000;

  const candidateItems: Array<Omit<EvidenceItem, "id">> = [];
  let redactedItems = 0;

  // 1. Priority 1: Export Surface Changes for this package
  for (const [filePath, diff] of Object.entries(analysis.exportDiffs)) {
    const changedFile = analysis.changedFiles.find((f) => f.path === filePath);
    if (changedFile?.pkg !== pkgName) continue;

    if (isSensitiveFile(filePath)) {
      redactedItems++;
      continue;
    }

    const lines: string[] = [];
    for (const a of diff.added) {
      lines.push(`+ added ${a.kind} "${a.name}": ${a.signature}`);
    }
    for (const r of diff.removed) {
      lines.push(`- removed ${r.kind} "${r.name}": ${r.signature}`);
    }
    for (const c of diff.changed) {
      lines.push(`~ modified ${c.kind} "${c.name}":`);
      lines.push(`  before: ${c.beforeSig}`);
      lines.push(`  after:  ${c.afterSig}`);
    }

    if (lines.length > 0) {
      candidateItems.push({
        type: "export-change",
        label: `Export changes in ${filePath}`,
        text: lines.join("\n"),
        files: [filePath],
      });
    }
  }

  // 2. Priority 2: Consumer Usages in Dependent Packages
  for (const candidate of analysis.breakingCandidates) {
    if (candidate.pkg !== pkgName || candidate.usages.length === 0) continue;

    const usageLines: string[] = [];
    const files: string[] = [];

    for (const usage of candidate.usages) {
      if (isSensitiveFile(usage.file)) {
        redactedItems++;
        continue;
      }
      files.push(usage.file);

      // Read surrounding context (2 lines before and after)
      let contextSnippet = usage.lineText;
      const absPath = resolve(root, usage.file);
      if (existsSync(absPath)) {
        try {
          const fileContent = readFileSync(absPath, "utf8");
          if (hasSecretContent(fileContent)) {
            redactedItems++;
            contextSnippet = "[redacted: sensitive file]";
          } else {
            const allLines = fileContent.split("\n");
            const startIdx = Math.max(0, usage.line - 3);
            const endIdx = Math.min(allLines.length, usage.line + 2);
            contextSnippet = allLines
              .slice(startIdx, endIdx)
              .map((l, idx) => {
                const lineNum = startIdx + idx + 1;
                const marker = lineNum === usage.line ? ">" : " ";
                return `${marker} ${lineNum}: ${l}`;
              })
              .join("\n");
          }
        } catch {
          // Fall back to lineText
        }
      }

      usageLines.push(
        `Call-site in ${usage.file}:${usage.line}\n${contextSnippet}${
          usage.arityMismatch ? `\nNote: ${usage.arityMismatch}` : ""
        }`
      );
    }

    if (usageLines.length > 0) {
      candidateItems.push({
        type: "usage",
        label: `Consumer usages of "${candidate.exportName}" in dependents`,
        text: usageLines.join("\n\n"),
        files,
      });
    }
  }

  // 3. Priority 3: Git Diff Hunks
  const pkgChangedFiles = analysis.changedFiles.filter((f) => f.pkg === pkgName);
  for (const changedFile of pkgChangedFiles) {
    if (isSensitiveFile(changedFile.path)) {
      redactedItems++;
      candidateItems.push({
        type: "diff",
        label: `Diff for ${changedFile.path}`,
        text: "[redacted: sensitive file]",
        files: [changedFile.path],
      });
      continue;
    }

    let diffText = "";
    const absPath = resolve(root, changedFile.path);

    if (changedFile.status === "?") {
      // Untracked file: synthesize diff
      if (existsSync(absPath)) {
        try {
          const content = readFileSync(absPath, "utf8");
          if (hasSecretContent(content)) {
            redactedItems++;
            diffText = "[redacted: sensitive file]";
          } else {
            diffText = content
              .split("\n")
              .map((l) => `+ ${l}`)
              .join("\n");
          }
        } catch {
          diffText = "+ (untracked file content unreadable)";
        }
      }
    } else {
      try {
        const rawDiff = await getDiff(root, { paths: [changedFile.path] });
        if (hasSecretContent(rawDiff)) {
          redactedItems++;
          diffText = "[redacted: sensitive file]";
        } else {
          diffText = rawDiff.trim();
        }
      } catch {
        diffText = "(diff unavailable)";
      }
    }

    // Cap single diff at 3000 chars
    if (diffText.length > 3000) {
      diffText = `${diffText.slice(0, 3000)}\n... [truncated]`;
    }

    if (diffText.length > 0) {
      candidateItems.push({
        type: "diff",
        label: `Diff for ${changedFile.path}`,
        text: diffText,
        files: [changedFile.path],
      });
    }
  }

  // 4. Priority 4: Dependency Paths
  const depInfo = analysis.dependents[pkgName];
  if (depInfo && (depInfo.direct.length > 0 || depInfo.transitive.length > 0)) {
    const pathLines: string[] = [];
    for (const d of depInfo.direct) {
      pathLines.push(`Direct dependent: ${d.name} (path: ${d.path.join(" -> ")})`);
    }
    for (const t of depInfo.transitive) {
      pathLines.push(`Transitive dependent: ${t.name} (path: ${t.path.join(" -> ")})`);
    }
    candidateItems.push({
      type: "dependency-path",
      label: `Dependents topology for ${pkgName}`,
      text: pathLines.join("\n"),
    });
  }

  // 5. Priority 5: Package Metadata
  const targetPkg = ctx.packages.find((p) => p.name === pkgName);
  if (targetPkg) {
    const metaText = `Package: ${targetPkg.name}\nDirectory: ${targetPkg.dir}\nVersion: ${
      targetPkg.version
    }\nDependencies: ${Object.keys(targetPkg.dependencies).join(", ") || "(none)"}`;
    candidateItems.push({
      type: "metadata",
      label: `Package metadata for ${pkgName}`,
      text: metaText,
    });
  }

  // Enforce Hard Budget (12,000 chars default)
  let currentChars = 0;
  const items: EvidenceItem[] = [];
  let truncated = false;
  let droppedItemsCount = 0;

  for (let i = 0; i < candidateItems.length; i++) {
    const raw = candidateItems[i];
    const itemTextLen = raw.text.length + raw.label.length;

    if (currentChars + itemTextLen > budgetChars && items.length > 0) {
      truncated = true;
      droppedItemsCount = candidateItems.length - i;
      break;
    }

    const id = `E${items.length + 1}`;
    items.push({
      id,
      type: raw.type,
      label: raw.label,
      text: raw.text,
      ...(raw.files ? { files: raw.files } : {}),
    });
    currentChars += itemTextLen;
  }

  // Candidate Tests
  const tests: EvidenceTest[] = [];
  let testIdx = 1;
  for (const t of analysis.candidateTests) {
    // Tests in this package or in direct/transitive dependents of this package
    const isDirectPkg = t.pkg === pkgName;
    const isDepPkg = depInfo
      ? depInfo.direct.some((d) => d.name === t.pkg) || depInfo.transitive.some((d) => d.name === t.pkg)
      : false;

    if (isDirectPkg || isDepPkg) {
      if (isSensitiveFile(t.file)) continue;
      tests.push({
        id: `T${testIdx++}`,
        file: t.file,
        pkg: t.pkg,
        reason: t.reason,
      });
    }
  }

  // Compute canonical content hash
  const canonicalData = JSON.stringify({
    pkgName,
    items: items.map((it) => ({ id: it.id, type: it.type, text: it.text })),
    tests: tests.map((ts) => ({ id: ts.id, file: ts.file })),
  });
  const contentHash = createHash("sha256").update(canonicalData).digest("hex");

  return {
    packageName: pkgName,
    items,
    tests,
    totalChars: currentChars,
    budgetChars,
    truncated,
    droppedItemsCount,
    redactedItems,
    contentHash,
  };
}
