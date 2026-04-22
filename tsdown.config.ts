import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: "esm",
  target: "node24",
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  minify: true,
  deps: {
    alwaysBundle: ["@modelcontextprotocol/sdk", "zod"],
  },
  define: {
    __SPANNER_MCP_VERSION__: JSON.stringify(pkg.version),
  },
});
