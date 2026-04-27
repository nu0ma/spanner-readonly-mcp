import { defineConfig } from "vitest/config";

// Three projects so each suite only pays the cost it needs:
//   - `unit` runs pure-JS tests; no Docker, no globalSetup.
//   - `e2e` runs against the Spanner Omni container started by
//     `test/global-setup.ts`.
//   - `smoke` runs the dist build smoke test against the self-contained
//     bundled server (no Spanner connection).
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "e2e",
          include: ["test/e2e.test.ts"],
          globalSetup: ["./test/global-setup.ts"],
          testTimeout: 30_000,
          // Omni's first DDL after boot is ~37s on arm64 (intrinsic schema-cache
          // initialization), and a single `server` SIGSEGV restart can extend
          // that further. 60s left no headroom; 120s comfortably covers both.
          hookTimeout: 120_000,
        },
      },
      {
        test: {
          name: "smoke",
          include: ["test/dist-smoke.test.ts"],
          // No globalSetup: the bundled server is self-contained and the
          // Spanner client inside it is constructed lazily.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
