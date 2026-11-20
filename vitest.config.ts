import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Used only by `npm run test:coverage`. `npm test` does not collect coverage.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Type declarations hold no code. The browser scripts' build output lives in public/js
      // and dist, outside src, and is left out so only the TypeScript sources are measured.
      exclude: ["src/**/*.d.ts", "public/js/**", "dist/**"],
      reporter: ["text", "text-summary", "json-summary"],
      reportsDirectory: "coverage",
    },
  },
});
