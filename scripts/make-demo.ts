import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, "..");
const demoDir = resolve(rootDir, "demo-monorepo");

console.log(`Creating demo monorepo at ${demoDir}...`);

// 1. Remove if exists
if (existsSync(demoDir)) {
  rmSync(demoDir, { recursive: true, force: true });
}

// Helper to write files ensuring directory exists
function writeFile(relativePath: string, content: string): void {
  const fullPath = resolve(demoDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content.trimStart(), "utf8");
}

// 2. Root package.json
writeFile(
  "package.json",
  JSON.stringify(
    {
      name: "demo-monorepo",
      private: true,
      workspaces: ["apps/*", "packages/*"],
    },
    null,
    2
  ) + "\n"
);

// 3. packages/shared
writeFile(
  "packages/shared/package.json",
  JSON.stringify(
    {
      name: "@demo/shared",
      version: "1.0.0",
      main: "src/index.ts",
    },
    null,
    2
  ) + "\n"
);

writeFile(
  "packages/shared/src/index.ts",
  `export function formatUser(name: string): string {
  return \`User: \${name.trim()}\`;
}
`
);

// 4. packages/auth
writeFile(
  "packages/auth/package.json",
  JSON.stringify(
    {
      name: "@demo/auth",
      version: "1.0.0",
      main: "src/index.ts",
      dependencies: {
        "@demo/shared": "1.0.0",
      },
    },
    null,
    2
  ) + "\n"
);

writeFile(
  "packages/auth/src/index.ts",
  `import { formatUser } from "@demo/shared";

export interface Token {
  token: string;
  user: string;
  expiresAt: number;
}

export function validateToken(token: string): boolean {
  return typeof token === "string" && token.startsWith("ey") && token.length > 10;
}

export function createToken(user: string): Token {
  const formatted = formatUser(user);
  return {
    token: \`ey-\${Buffer.from(formatted).toString("base64")}\`,
    user: formatted,
    expiresAt: Date.now() + 3600 * 1000,
  };
}
`
);

writeFile(
  "packages/auth/src/index.test.ts",
  `import { validateToken } from "./index.js";

const isValid = validateToken("ey-mock-token-12345");
const isInvalid = validateToken("invalid");

if (!isValid || isInvalid) {
  throw new Error("Token validation test failed");
}
console.log("Auth tests passed!");
`
);

// 5. apps/api
writeFile(
  "apps/api/package.json",
  JSON.stringify(
    {
      name: "@demo/api",
      version: "1.0.0",
      main: "src/server.ts",
      dependencies: {
        "@demo/auth": "1.0.0",
        "@demo/shared": "1.0.0",
      },
    },
    null,
    2
  ) + "\n"
);

writeFile(
  "apps/api/src/server.ts",
  `import { validateToken } from "@demo/auth";
import { formatUser } from "@demo/shared";

export function handleRequest(authHeader: string): { status: number; message: string } {
  const isValid = validateToken(authHeader);
  if (!isValid) {
    return { status: 401, message: "Unauthorized" };
  }
  return { status: 200, message: \`Hello \${formatUser("API Caller")}\` };
}

const authHeader = "ey-valid-token-example";
handleRequest(authHeader);
`
);

// 6. apps/web
writeFile(
  "apps/web/package.json",
  JSON.stringify(
    {
      name: "@demo/web",
      version: "1.0.0",
      main: "src/app.ts",
      dependencies: {
        "@demo/auth": "1.0.0",
      },
    },
    null,
    2
  ) + "\n"
);

writeFile(
  "apps/web/src/app.ts",
  `import { createToken } from "@demo/auth";

export function renderApp(username: string): void {
  const token = createToken(username);
  console.log(\`Rendered web app for \${token.user}\`);
}

renderApp("alice");
`
);

// 7. Git repo initialization with deterministic single commit
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "RepoPilot Demo",
  GIT_AUTHOR_EMAIL: "demo@repopilot.local",
  GIT_COMMITTER_NAME: "RepoPilot Demo",
  GIT_COMMITTER_EMAIL: "demo@repopilot.local",
  GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z",
};

execSync("git init -b main", { cwd: demoDir, stdio: "ignore" });
execSync("git config user.name \"RepoPilot Demo\"", { cwd: demoDir, stdio: "ignore" });
execSync("git config user.email \"demo@repopilot.local\"", { cwd: demoDir, stdio: "ignore" });
execSync("git add .", { cwd: demoDir, stdio: "ignore" });
execSync("git commit -m \"chore: initial monorepo baseline\"", {
  cwd: demoDir,
  env: gitEnv,
  stdio: "ignore",
});

console.log("Demo monorepo created successfully with deterministic git commit!");
