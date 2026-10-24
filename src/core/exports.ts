import ts from "typescript";

export type ExportKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "enum"
  | "reexport"
  | "default";

export interface ExportItem {
  name: string;
  kind: ExportKind;
  signature: string;
}

export interface ExportChanged {
  name: string;
  kind: ExportKind;
  beforeSig: string;
  afterSig: string;
}

export interface ExportDiff {
  added: ExportItem[];
  removed: ExportItem[];
  changed: ExportChanged[];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (ts.canHaveModifiers(node)) {
    const modifiers = ts.getModifiers(node);
    return modifiers?.some((m) => m.kind === kind) ?? false;
  }
  return false;
}

/**
 * Extracts exported symbols and their normalized signatures from source code using TypeScript AST.
 */
export function extractExports(source: string, filePath: string): Record<string, ExportItem> {
  if (!source || source.trim().length === 0) {
    return {};
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") || filePath.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS
  );

  const exportsMap: Record<string, ExportItem> = {};

  for (const stmt of sourceFile.statements) {
    const isExported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);

    // 1. Function declaration
    if (ts.isFunctionDeclaration(stmt) && (isExported || isDefault)) {
      const name = isDefault && !stmt.name ? "default" : (stmt.name?.text ?? "default");
      const params = `(${stmt.parameters.map((p) => p.getText(sourceFile)).join(", ")})`;
      const ret = stmt.type ? `: ${stmt.type.getText(sourceFile).trim()}` : "";
      const signature = `${params}${ret}`.replace(/\s+/g, " ").trim();
      exportsMap[name] = {
        name,
        kind: isDefault ? "default" : "function",
        signature,
      };
      continue;
    }

    // 2. Interface declaration
    if (ts.isInterfaceDeclaration(stmt) && isExported) {
      const name = stmt.name.text;
      const members = stmt.members
        .map((m) => m.getText(sourceFile).trim().replace(/;$/, ""))
        .sort()
        .join("; ");
      const signature = `{ ${members} }`.replace(/\s+/g, " ").trim();
      exportsMap[name] = {
        name,
        kind: "interface",
        signature,
      };
      continue;
    }

    // 3. Type alias declaration
    if (ts.isTypeAliasDeclaration(stmt) && isExported) {
      const name = stmt.name.text;
      const typeText = stmt.type.getText(sourceFile).replace(/\s+/g, " ").trim();
      exportsMap[name] = {
        name,
        kind: "type",
        signature: `type ${name} = ${typeText}`,
      };
      continue;
    }

    // 4. Variable statement (const/let/var)
    if (ts.isVariableStatement(stmt) && isExported) {
      for (const decl of stmt.declarationList.declarations) {
        const name = decl.name.getText(sourceFile);
        if (
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          const fn = decl.initializer;
          const params = `(${fn.parameters.map((p) => p.getText(sourceFile)).join(", ")})`;
          const ret = fn.type ? `: ${fn.type.getText(sourceFile).trim()}` : "";
          const signature = `${params}${ret}`.replace(/\s+/g, " ").trim();
          exportsMap[name] = {
            name,
            kind: "function",
            signature,
          };
        } else {
          const sig = (decl.type ? decl.type.getText(sourceFile) : decl.initializer?.getText(sourceFile) ?? "unknown")
            .replace(/\s+/g, " ")
            .trim();
          exportsMap[name] = {
            name,
            kind: "const",
            signature: sig,
          };
        }
      }
      continue;
    }

    // 5. Class declaration
    if (ts.isClassDeclaration(stmt) && (isExported || isDefault)) {
      const name = isDefault && !stmt.name ? "default" : (stmt.name?.text ?? "default");
      const members = stmt.members
        .filter((m) => !hasModifier(m, ts.SyntaxKind.PrivateKeyword))
        .map((m) => m.getText(sourceFile).trim().replace(/;$/, "").replace(/\{[\s\S]*\}$/, "").trim())
        .sort()
        .join("; ");
      exportsMap[name] = {
        name,
        kind: "class",
        signature: `class ${name} { ${members} }`.replace(/\s+/g, " ").trim(),
      };
      continue;
    }

    // 6. Enum declaration
    if (ts.isEnumDeclaration(stmt) && isExported) {
      const name = stmt.name.text;
      const members = stmt.members.map((m) => m.name.getText(sourceFile)).sort().join(", ");
      exportsMap[name] = {
        name,
        kind: "enum",
        signature: `enum ${name} { ${members} }`,
      };
      continue;
    }

    // 7. Export declaration (named exports or re-exports)
    if (ts.isExportDeclaration(stmt)) {
      const moduleSpec = stmt.moduleSpecifier ? stmt.moduleSpecifier.getText(sourceFile) : "";
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const name = el.name.text;
          const orig = el.propertyName ? el.propertyName.text : name;
          exportsMap[name] = {
            name,
            kind: "reexport",
            signature: moduleSpec ? `export { ${orig} as ${name} } from ${moduleSpec}` : `export { ${orig} as ${name} }`,
          };
        }
      } else if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause)) {
        const name = stmt.exportClause.name.text;
        exportsMap[name] = {
          name,
          kind: "reexport",
          signature: `export * as ${name} from ${moduleSpec}`,
        };
      } else if (!stmt.exportClause && moduleSpec) {
        const name = `* from ${moduleSpec}`;
        exportsMap[name] = {
          name,
          kind: "reexport",
          signature: `export * from ${moduleSpec}`,
        };
      }
      continue;
    }

    // 8. Export assignment (`export default ...`)
    if (ts.isExportAssignment(stmt)) {
      const expr = stmt.expression.getText(sourceFile).replace(/\s+/g, " ").trim();
      exportsMap["default"] = {
        name: "default",
        kind: "default",
        signature: `export default ${expr}`,
      };
    }
  }

  return exportsMap;
}

/**
 * Computes structural differences between before and after export surfaces.
 */
export function diffExports(
  before: Record<string, ExportItem>,
  after: Record<string, ExportItem>
): ExportDiff {
  const added: ExportItem[] = [];
  const removed: ExportItem[] = [];
  const changed: ExportChanged[] = [];

  const allNames = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const name of allNames) {
    const beforeItem = before[name];
    const afterItem = after[name];

    if (!beforeItem && afterItem) {
      added.push(afterItem);
    } else if (beforeItem && !afterItem) {
      removed.push(beforeItem);
    } else if (beforeItem && afterItem) {
      if (beforeItem.signature !== afterItem.signature) {
        changed.push({
          name,
          kind: afterItem.kind,
          beforeSig: beforeItem.signature,
          afterSig: afterItem.signature,
        });
      }
    }
  }

  added.sort((a, b) => a.name.localeCompare(b.name));
  removed.sort((a, b) => a.name.localeCompare(b.name));
  changed.sort((a, b) => a.name.localeCompare(b.name));

  return { added, removed, changed };
}
