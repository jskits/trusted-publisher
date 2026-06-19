import { defineConfig, type UserConfig } from "tsdown/config";

const config: UserConfig = defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts", "src/cli.ts"],
  fixedExtension: false,
  format: "esm",
  outDir: "dist",
  platform: "node",
  sourcemap: false,
  target: "node22",
});

export default config;
