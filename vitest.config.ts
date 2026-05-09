import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Behavioural plugin tests live under tests/plugin/transformed/** and
    // require the plugin to be active during compilation — they are run
    // via `vitest.transformed.config.ts` (npm run test:transformed).
    exclude: ["node_modules/**", "dist/**", "tests/plugin/transformed/**"],
    globals: false,
  },
});
