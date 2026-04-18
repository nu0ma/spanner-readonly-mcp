import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
  },
});
