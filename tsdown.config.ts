import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: "esm",
  target: "node18",
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
});
