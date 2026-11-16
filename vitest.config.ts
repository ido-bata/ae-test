import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `specs/` holds suites written in the ae-test DSL, executed by the
    // ae-test runner. Vitest must not treat them as its own suites, or it
    // fails on them for having no vitest tests in them.
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "specs/**", ".ae-test-results/**"],
    // Some tests exec the real npm CLI or tsc; a cold spawn alone can take
    // tens of seconds on a loaded machine, so the 5s default is too tight.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
