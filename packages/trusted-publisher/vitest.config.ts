import { defineConfig, type ViteUserConfigExport } from "vitest/config";

const config: ViteUserConfigExport = defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});

export default config;
