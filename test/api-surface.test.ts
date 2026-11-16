/**
 * Public API surface contract (Issue #36).
 *
 * The list below is the 1.0 candidate surface: what a consumer may import
 * from `@ido-bata/ae-test`. Adding a name is a minor change; removing or
 * renaming one is breaking and must be collected into a major (or, before
 * 1.0, a beta) per docs/api.md. This test is the mechanical check that the
 * surface only moves deliberately.
 */

import { describe, expect, it } from "vitest";

import * as api from "../dist/index.js";

const PUBLIC_EXPORTS = [
  "AE_TEST_VERSION",
  "AssertionError",
  "AsyncExpectation",
  "CAPABILITY_CATALOG_SCHEMA",
  "CONFIG_FILE_NAME",
  "CONFORMANCE_RECORD_VERSION",
  "CONFORMANCE_REPORT_SCHEMA",
  "ConfigError",
  "ConformanceError",
  "DEFAULT_BASELINE_DIR",
  "DEFAULT_RESULTS_DIR",
  "DEFAULT_SPEC_PATTERNS",
  "DEFAULT_TIMEOUT_MS",
  "HostNotOwnedError",
  "SnapshotStore",
  "TestFixture",
  "buildConformanceReport",
  "clearRegistry",
  "countByStatus",
  "discoverSpecs",
  "environmentBlockReason",
  "evaluateCompatibility",
  "exitCodeFor",
  "expect",
  "expectFrame",
  "findConfigFile",
  "formatFailure",
  "formatResultLine",
  "formatRun",
  "formatSummary",
  "hasFailures",
  "hostProvenance",
  "loadCapabilityCatalog",
  "loadConfigFile",
  "loadTestFiles",
  "registeredTests",
  "run",
  "setDeclaringFile",
  "skip",
  "test",
  "toMatchObject",
  "writeConformanceReport",
].sort();

describe("public API surface", () => {
  it("exports exactly the contracted names", () => {
    expect(Object.keys(api).sort()).toEqual(PUBLIC_EXPORTS);
  });

  it("does not leak internal modules", () => {
    // Helpers that exist for the runner's own use stay unexported: a consumer
    // reaching into them would pin internals the contract does not cover.
    for (const internal of [
      "comparePngFiles",
      "writeImageDiffArtifacts",
      "formatImageDifference",
      "snapshotEnvironmentKey",
    ]) {
      expect(api).not.toHaveProperty(internal);
    }
  });
});
