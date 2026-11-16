import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FakeAfterEffectsTransport } from "@ido-bata/ae-a8n/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildConformanceReport,
  clearRegistry,
  loadCapabilityCatalog,
  run,
} from "../dist/index.js";
import type { ConformanceReport, RunSummary, TestResult } from "../dist/index.js";

const SPEC = resolve(import.meta.dirname, "..", "specs", "plugin-render.spec.ts");
const PROJECTS_DIR = resolve(import.meta.dirname, "..", "fixtures");
const CAPABILITY_IDS = [
  "ae.operation.project.open",
  "ae.operation.comp.info",
  "ae.operation.comp.get-layer",
  "ae.operation.layer.get-layer",
  "ae.operation.effect.apply",
  "ae.operation.effect.set-parameter",
  "ae.operation.effect.get-parameter",
  "ae.operation.render.frame",
];

let dir: string;

beforeEach(() => {
  clearRegistry();
  dir = mkdtempSync(join(tmpdir(), "ae-test-conformance-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function result(
  overrides: Partial<TestResult> = {},
  omit: readonly (keyof TestResult)[] = [],
): TestResult {
  const merged: TestResult = {
    id: "spec#1",
    title: "a conformance test",
    file: "spec.ts",
    status: "passed",
    durationMs: 1,
    artifacts: [],
    capabilities: [],
    session: {
      uid: 501,
      asid: 1,
      ae: { version: "26.5", build: "89" },
      extensions: [],
      fixtures: [],
    },
    cleanup: { status: "ok", quit: true },
    ...overrides,
  };
  const mutable = merged as Partial<TestResult>;
  for (const key of omit) {
    delete mutable[key];
  }
  return merged;
}

function summary(results: readonly TestResult[]): RunSummary {
  return {
    results,
    durationMs: 1,
    resultsDir: dir,
    reportPath: join(dir, "report.json"),
  };
}

function reportFor(
  results: readonly TestResult[],
  options: Partial<Parameters<typeof buildConformanceReport>[1]> = {},
): ConformanceReport {
  return buildConformanceReport(summary(results), {
    host: "fake",
    runId: "run-test",
    recordedAt: "2026-11-16T00:00:00.000Z",
    sourceSha: "abc123",
    ...options,
  });
}

describe("conformance classification", () => {
  it("never lets a fake-host pass read as real-host verified", () => {
    const fake = reportFor([result()]).records[0];
    expect(fake?.classification).toBe("fake-only");
    expect(fake?.verification).toBe("automated-fake");
    expect(fake?.catalogBinding?.kind).toBe("automated-test");

    const real = reportFor([result()], { host: "real" }).records[0];
    expect(real?.classification).toBe("real-host-verified");
    expect(real?.verification).toBe("verified-real-host");
    expect(real?.catalogBinding?.kind).toBe("real-host");
  });

  it("keeps refused, unknown, blocked and not-run distinct", () => {
    const report = reportFor([
      result(
        {
          id: "refused#1",
          status: "failed",
          failure: {
            name: "HostNotOwnedError",
            message: "refused",
            ownership: { kind: "attached", evidence: "pid 1" },
            lastOperations: [],
          },
        },
        ["session", "cleanup"],
      ),
      result({
        id: "timeout#1",
        status: "timed-out",
        failure: { name: "TestTimeoutError", message: "slow", lastOperations: [] },
      }),
      result(
        { id: "blocked#1", status: "blocked", blockedReason: "host unknown" },
        ["session", "cleanup"],
      ),
      result({ id: "skip#1", status: "skipped", durationMs: 0 }, ["session", "cleanup"]),
    ]);

    expect(report.records.map((record) => record.classification)).toEqual([
      "refused",
      "unknown",
      "blocked",
      "not-run",
    ]);
    expect(report.records.map((record) => record.result)).toEqual([
      "FAIL",
      "UNKNOWN",
      "BLOCKED",
      "NOT_RUN",
    ]);
    expect(report.records.every((record) => record.verification === "not-run")).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("records unsupported and refused expectations as their own classes", () => {
    const report = reportFor([
      result({ id: "unsupported#1", conformance: "unsupported" }),
      result({ id: "refused#1", conformance: "refused" }),
      result({ id: "unknown#1", conformance: "unknown" }),
    ]);

    expect(report.records.map((record) => record.classification)).toEqual([
      "unsupported",
      "refused",
      "unknown",
    ]);
    expect(report.records.every((record) => record.catalogBinding === null)).toBe(true);
  });

  it("marks a capability missing from the catalog as unknown, not fake-only", () => {
    const catalogPath = join(dir, "catalog.json");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        schema: "ae-devtools.capability-catalog/v1",
        records: [{ id: "ae.operation.project.open" }],
      }),
    );

    const report = reportFor(
      [result({ capabilities: ["ae.operation.project.open", "ae.operation.missing"] })],
      { catalogPath },
    );
    const record = report.records[0];

    expect(record?.classification).toBe("unknown");
    expect(record?.result).toBe("UNKNOWN");
    expect(record?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unknown-capability", capabilityId: "ae.operation.missing" }),
      ]),
    );
    expect(report.ok).toBe(false);
  });

  it("hashes cited artifacts so a consumer can recompute them", () => {
    const artifactPath = join(dir, "render.png");
    writeFileSync(artifactPath, "png-bytes");
    const report = reportFor([
      result({
        artifacts: [
          { name: "render", path: artifactPath, bytes: statSync(artifactPath).size, kind: "render" },
        ],
      }),
    ]);

    expect(report.records[0]?.artifactHashes[0]?.sha256).toBe(
      createHash("sha256").update("png-bytes").digest("hex"),
    );
  });
});

describe("capability catalog", () => {
  it("rejects a catalog with the wrong schema instead of guessing", () => {
    const catalogPath = join(dir, "catalog.json");
    writeFileSync(catalogPath, JSON.stringify({ schema: "other/v1", records: [] }));
    expect(() => loadCapabilityCatalog(catalogPath)).toThrow(/schema/);
  });
});

describe("runner integration", () => {
  it("writes conformance.json beside report.json for a fake-host run", async () => {
    const catalogPath = join(dir, "catalog.json");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        schema: "ae-devtools.capability-catalog/v1",
        records: CAPABILITY_IDS.map((id) => ({ id })),
      }),
    );
    const resultsDir = join(dir, "results");

    const summary = await run({
      files: [SPEC],
      resultsDir,
      projectsDir: PROJECTS_DIR,
      transport: new FakeAfterEffectsTransport(),
      updateSnapshots: true,
      conformance: {
        host: "fake",
        catalogPath,
        sourceSha: "deadbeef",
        runId: "vertical-slice",
        recordedAt: "2026-11-16T00:00:00.000Z",
      },
    });

    expect(summary.conformancePath).toBe(join(resultsDir, "conformance.json"));
    const report = JSON.parse(readFileSync(summary.conformancePath ?? "", "utf-8")) as ConformanceReport;
    expect(report.schema).toBe("ae-test.conformance/v1");
    expect(report.ok).toBe(true);
    expect(report.host).toBe("fake");
    expect(report.sourceSha).toBe("deadbeef");
    expect(report.catalog?.recordCount).toBe(CAPABILITY_IDS.length);
    expect(report.summary.byClassification["fake-only"]).toBe(4);
    expect(report.records.every((record) => record.classification === "fake-only")).toBe(true);
    expect(
      report.records.every((record) => record.artifactHashes.every((artifact) => artifact.sha256 !== null)),
    ).toBe(true);

    const runReport = JSON.parse(readFileSync(summary.reportPath, "utf-8")) as RunSummary;
    expect(runReport.conformancePath).toBe(summary.conformancePath);
  });
});
