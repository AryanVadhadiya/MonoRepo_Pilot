# RepoPilot AI 🚀

> **Git-backed, monorepo-native CLI** (TypeScript, Node 20+, ESM) that discovers workspace packages, constructs a dependency graph, pinpoints packages affected by changes, performs AST-level export surface diffing, and uses an LLM to explain breaking-change risk and recommend tests.

---

## Key Features

- **Git-Backed & Lightweight**: Operates directly on standard Git status and diffs. No Docker, no external databases, no microservices.
- **Monorepo-Native Workspace Discovery**: Discovers packages from npm workspaces without third-party glob dependencies, mapping file paths to owning packages using longest-prefix matching.
- **Incremental Indexing & Cache**: Hashes and indexes `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs` source files with smart `size` and `mtimeMs` cache invalidation. Corrupt index recovery built-in.
- **Dependency Graph & Reverse Traversal**: Merges manifest dependencies (`package.json`) with code-level import statements. Discovers direct and transitive dependents with shortest paths and highlights hygiene issues (`declaredButUnused`, `importedButUndeclared`).
- **AST Export-Surface Diffing**: Uses the TypeScript compiler API to extract normalized signatures for exported functions, interfaces, types, consts, classes, and enums, diffing before/after shapes across commits or working trees.
- **Deterministic Impact Analysis & Usage Detection**: Scans dependent packages for call-sites of modified exports and applies heuristic arity mismatch detection.
- **Provider-Agnostic AI Pipeline**:
  - Structured output schemas with strict validation.
  - Strict grounding guardrails: automatically drops ungrounded findings, downgrades unverified claims, and drops hallucinated package/test names.
  - Bounded evidence budgets (12k char default) with automatic secret redaction (`.env*`, `*.key`, `API_KEY=`, etc.).
  - Exponential backoff with retry and fallback model support.
  - Offline `mock` provider for air-gapped or CI verification.

---

## Architecture Overview

```
                               ┌─────────────────────────┐
                               │       Git Repository    │
                               └────────────┬────────────┘
                                            │
                          ┌─────────────────┴─────────────────┐
                          ▼                                   ▼
               ┌──────────────────────┐           ┌──────────────────────┐
               │  Workspace Discovery │           │  Incremental Indexer │
               │ (packages & entries) │           │ (imports & mtimes)   │
               └──────────┬───────────┘           └──────────┬───────────┘
                          │                                  │
                          └─────────────────┬────────────────┘
                                            │
                                            ▼
                               ┌─────────────────────────┐
                               │ Package Dependency Graph│
                               │  (direct & transitive)  │
                               └────────────┬────────────┘
                                            │
                        ┌───────────────────┴───────────────────┐
                        ▼                                       ▼
             ┌─────────────────────┐                 ┌─────────────────────┐
             │  Export Diff Engine │                 │ Call-Site Scanner   │
             │   (TypeScript AST)  │                 │  (Arity Heuristic)  │
             └──────────┬──────────┘                 └──────────┬──────────┘
                        │                                       │
                        └───────────────────┬───────────────────┘
                                            ▼
                               ┌─────────────────────────┐
                               │  Deterministic Baseline │
                               │  (Risk: High/Med/Low)   │
                               └────────────┬────────────┘
                                            │ (Optional --ai)
                                            ▼
                               ┌─────────────────────────┐
                               │    AI Impact Pipeline   │
                               │  - Bounded Evidence     │
                               │  - Secret Redaction     │
                               │  - Grounding Guardrails │
                               └─────────────────────────┘
```

---

## Installation & Setup

### Prerequisites
- Node.js 20.0.0 or higher
- Git

### Installation
```bash
git clone https://github.com/AryanVadhadiya/MonoRepo_Pilot.git
cd MonoRepo_Pilot
npm install
npm run build
```

Link or use via `tsx`:
```bash
npm run dev -- --help
# Or test built binary:
node dist/cli.js --help
```

---

## CLI Commands

### 1. Initialize RepoPilot
```bash
repopilot init [-C <path>] [--json]
```
Initializes `.repopilot/config.json` and ensures `.repopilot/` is appended to `.git/info/exclude` (leaves tracked `.gitignore` untouched). Discovers and prints all workspace packages and dependency counts.

### 2. Package-Aware Status
```bash
repopilot status [-C <path>] [--json]
```
Groups dirty, staged, and untracked files by workspace package and root unowned files, displaying status markers (`M`, `A`, `D`, `R`, `?`) and a summary count.

### 3. Package Commit History
```bash
repopilot history [--package <name|dir>] [--limit 10] [-C <path>] [--json]
```
Displays delimiter-safe commit history for a specific package or repo-wide.

### 4. Dependency Graph
```bash
repopilot graph [--package <name|dir>] [-C <path>] [--json]
```
Displays the ASCII workspace dependency tree, evidence kinds (`manifest`, `import`), hygiene warnings, or a focused "dependents of X" view.

### 5. Deterministic & AI Impact Analysis
```bash
# Deterministic analysis (no API key required)
repopilot analyze [-C <path>] [--staged] [--base <rev>] [--json]

# Privacy/Dry-run demonstration (inspect bounded evidence without calling LLM)
repopilot analyze --show-evidence

# AI-assisted explanation and ranking
repopilot analyze --ai [--refresh] [--provider <gemini|mock>] [--model <model-name>]
```

### 6. Cache Management
```bash
repopilot cache stats [--json]
repopilot cache clear
```

---

## Deterministic Risk Model

| Risk Level | Trigger Condition |
| :--- | :--- |
| **`HIGH`** | Export surface modified and active consumer call-sites matched in dependent packages (or arity mismatch detected). |
| **`MEDIUM`** | Export surface modified without matched local usages, OR changed package has transitive dependents. |
| **`LOW`** | Modifications are internal to the package with no detected impact on dependent packages. |
| **`NONE`** | Clean working tree with no changes. |

> [!NOTE]
> When `--ai` is enabled, the final risk level is `max(deterministicRisk, aiRisk)`. The AI cannot downgrade verified deterministic risks.

---

## Demo Monorepo Generator

Generate a test monorepo with cross-package dependencies and deterministic Git commit timestamps:
```bash
npm run demo:make
```
Structure created at `./demo-monorepo`:
- `packages/shared`: `@demo/shared`
- `packages/auth`: `@demo/auth` (depends on `@demo/shared`)
- `apps/api`: `@demo/api` (depends on `@demo/auth` and `@demo/shared`)
- `apps/web`: `@demo/web` (depends on `@demo/auth`)

---

## License
MIT
