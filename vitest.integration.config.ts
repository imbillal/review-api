import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    pool: "forks",
    fileParallelism: false,
    setupFiles: ["./tests/integration/env.setup.ts"],
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
