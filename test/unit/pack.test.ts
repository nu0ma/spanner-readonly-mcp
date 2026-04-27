import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Repo root, resolved relative to this test file so the test is robust
// against vitest's cwd being something other than the project root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The exact set of files that should land in the published tarball.
// Adding anything here means we are intentionally widening the publish
// surface. Removing anything means we are intentionally shrinking it.
// In either case, this list must be reviewed in the same PR as the change
// to package.json's "files" field.
const EXPECTED_FILES = [
  ".claude-plugin/marketplace.json",
  ".claude-plugin/plugin.json",
  ".mcp.json",
  "LICENSE",
  "README.md",
  "dist/index.mjs",
  "package.json",
] as const;

// Paths/prefixes that must never appear in the publish payload. Each entry
// is matched as a path-prefix against the actual files list. This is an
// allow-list-with-deny-list belt-and-suspenders: even if EXPECTED_FILES is
// accidentally widened, these explicit denies should still trip.
const FORBIDDEN_PREFIXES = [
  "src/",
  "test/",
  "tests/",
  "docs/",
  ".github/",
  ".kiro/",
  ".claude/",
  ".vscode/",
  "node_modules/",
  "coverage/",
  "scripts/",
];

const FORBIDDEN_EXACT = [
  "tsconfig.json",
  "tsdown.config.ts",
  "vitest.config.ts",
  "biome.json",
  "biome.jsonc",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".env",
  ".env.example",
  ".gitignore",
  ".npmrc",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
];

interface NpmPackEntry {
  path: string;
  size: number;
  mode: number;
}

interface NpmPackReport {
  files: NpmPackEntry[];
  entryCount: number;
}

function runNpmPackDryRun(): NpmPackReport[] {
  // npm prints progress chatter to stderr; we only want the JSON on stdout.
  const stdout = execSync("npm pack --dry-run --json", {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(stdout) as NpmPackReport[];
}

describe("npm pack publish allowlist", () => {
  let actualFiles: string[];

  beforeAll(() => {
    // npm pack --dry-run does not trigger lifecycle scripts, so dist/ may
    // be missing in a fresh checkout. Build once to make the assertion
    // deterministic. tsdown's bundle takes ~1s, so this is cheap.
    execSync("pnpm build", {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });

    const report = runNpmPackDryRun();
    expect(report).toHaveLength(1);
    actualFiles = report[0].files.map((f) => f.path);
  });

  it("publishes exactly the expected file set", () => {
    expect([...actualFiles].sort()).toEqual([...EXPECTED_FILES].sort());
  });

  it("reports entryCount matching the expected file count", () => {
    const report = runNpmPackDryRun();
    expect(report[0].entryCount).toBe(EXPECTED_FILES.length);
  });

  it.each(EXPECTED_FILES)("includes %s", (expected) => {
    expect(actualFiles).toContain(expected);
  });

  it("does not publish any forbidden directory", () => {
    const leaks = actualFiles.filter((f) =>
      FORBIDDEN_PREFIXES.some((prefix) => f.startsWith(prefix)),
    );
    expect(leaks).toEqual([]);
  });

  it("does not publish any forbidden top-level file", () => {
    const leaks = actualFiles.filter((f) => FORBIDDEN_EXACT.includes(f));
    expect(leaks).toEqual([]);
  });

  it("does not publish source TypeScript", () => {
    const leaks = actualFiles.filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"),
    );
    expect(leaks).toEqual([]);
  });
});
