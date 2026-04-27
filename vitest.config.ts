import { defineConfig } from "vitest/config";

// Two projects so the dist smoke test can run without spinning up the
// Spanner Omni container that the e2e suite needs.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    projects: [
      {
        test: {
          name: "e2e",
          include: ["test/e2e.test.ts"],
          globalSetup: ["./test/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
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
