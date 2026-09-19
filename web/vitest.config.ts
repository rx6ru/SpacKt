import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  environment: "node", include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  coverage: { provider: "v8", include: ["src/domain/**", "src/engines/**", "src/net/**", "src/runtime/**", "src/store/**", "src/chart/**"],
    exclude: ["**/*.test.*"], thresholds: { lines: 80, branches: 80 } }
} });
