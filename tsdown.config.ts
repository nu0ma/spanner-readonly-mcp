import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: "esm",
  target: "node24",
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  minify: true,
});
