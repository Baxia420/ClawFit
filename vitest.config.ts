import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/**/*.test.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
    coverage: { reporter: ["text", "html"] },
  },
});
