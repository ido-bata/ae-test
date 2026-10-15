/**
 * `@ido-bata/ae-test` — Playwright-like automated testing for After Effects.
 *
 * ```ts
 * import { test } from "@ido-bata/ae-test";
 *
 * test("plugin renders correctly", async ({ ae, fixture, expectFrame }) => {
 *   const project = await ae.openProject(fixture.project("fixture.aep"));
 *   const comp = await project.comp("Main");
 *   const layer = await comp.layer("Solid 1");
 *   // Match names, not display names: display names are localised.
 *   const effect = await layer.effects.apply("ADBE Gaussian Blur 2");
 *   await effect.parameter("ADBE Gaussian Blur 2-0001").set(50);
 *
 *   const frame = await comp.renderFrame(0);
 *   await expectFrame(frame).toMatchSnapshot("main-frame-0");
 * });
 * ```
 *
 * After Effects operations come from `ae-a8n`. This package re-implements none
 * of them; it provides the test experience around them.
 */

export { test, skip, registeredTests, clearRegistry, setDeclaringFile, DEFAULT_TIMEOUT_MS } from "./registry.js";
export type { TestOptions } from "./registry.js";

export {
  AsyncExpectation,
  AssertionError,
  expect,
  expectFrame,
  toMatchObject,
} from "./expect.js";
export { SnapshotStore } from "./snapshot.js";
export type { SnapshotStoreOptions } from "./snapshot.js";

export { TestFixture } from "./fixture.js";
export type { FixtureOptions } from "./fixture.js";

export { run, loadTestFiles, countByStatus, hasFailures, DEFAULT_RESULTS_DIR } from "./runner.js";
export type { RunOptions } from "./runner.js";

export {
  formatRun,
  formatResultLine,
  formatFailure,
  formatSummary,
  exitCodeFor,
} from "./report.js";

export type {
  Artifact,
  Fixture,
  RunSummary,
  TestContext,
  TestDeclaration,
  TestFailure,
  TestFn,
  TestInfo,
  TestResult,
  TestStatus,
} from "./types.js";

export const AE_TEST_VERSION = "0.1.0-alpha.0";
