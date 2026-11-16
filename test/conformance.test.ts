import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FakeAfterEffectsTransport } from "@ido-bata/ae-a8n/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildConformanceReport,
  clearRegistry,
  environmentBlockReason,
  evaluateCompatibility,
  exitCodeFor,
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
      transport: "fake-in-process",
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

function realSession(): NonNullable<TestResult["session"]> {
  return {
    uid: 501,
    asid: 1,
    ae: { version: "26.5", build: "89" },
    extensions: [],
    fixtures: [],
    transport: "script-invocation",
  };
}

function summary(results: readonly TestResult[]): RunSummary {
  return {
    schema: "ae-test.report/v1",
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

    const real = reportFor([result({ session: realSession() })], { host: "real" })
      .records[0];
    expect(real?.classification).toBe("real-host-verified");
    expect(real?.verification).toBe("verified-real-host");
    expect(real?.catalogBinding?.kind).toBe("real-host");
  });

  it("promotes on transport provenance, not the declared host", () => {
    // The hole this guards: a caller injects the fake transport through the
    // public API but declares host "real". The declaration is a claim; the
    // transport kind is the evidence, and it says fake.
    const declaredReal = reportFor([result()], { host: "real" });
    expect(declaredReal.records[0]?.classification).toBe("fake-only");
    expect(declaredReal.records[0]?.verification).toBe("automated-fake");
    expect(declaredReal.records[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "host-provenance-mismatch" }),
      ]),
    );
    expect(declaredReal.ok).toBe(false);

    // The mirror image: a real transport under a "fake" declaration still
    // cannot hide that the evidence is real-host.
    const declaredFake = reportFor([result({ session: realSession() })], {
      host: "fake",
    });
    expect(declaredFake.records[0]?.classification).toBe("real-host-verified");
    expect(declaredFake.records[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "host-provenance-mismatch" }),
      ]),
    );
    expect(declaredFake.ok).toBe(false);
  });

  it("never promotes a session whose transport provenance is unrecognized", () => {
    const report = reportFor([
      result({
        session: { ...realSession(), transport: "custom-remote" },
      }),
    ]);
    const record = report.records[0];

    expect(record?.classification).toBe("unknown");
    expect(record?.result).toBe("UNKNOWN");
    expect(record?.catalogBinding).toBeNull();
    expect(record?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "host-provenance-unknown" }),
      ]),
    );
    // The provenance diagnostic itself stays a warning under a fake
    // declaration — the record simply cannot claim either side. The report
    // is still not ok, because a test that declared "pass" produced an
    // UNKNOWN record (conformance-expectation-mismatch).
    expect(
      record?.diagnostics.find((d) => d.code === "host-provenance-unknown")?.severity,
    ).toBe("warning");
    expect(report.ok).toBe(false);

    // A real declaration with unproven provenance is an error on both
    // counts: the run cannot stand behind its claim, and the pass produced
    // an UNKNOWN record.
    const declaredReal = reportFor(
      [result({ session: { ...realSession(), transport: null } })],
      { host: "real" },
    );
    expect(declaredReal.records[0]?.classification).toBe("unknown");
    expect(declaredReal.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "host-provenance-unknown",
          severity: "error",
        }),
      ]),
    );
    expect(declaredReal.ok).toBe(false);
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

  it("treats undecidable ownership as unknown, not refused", () => {
    const report = reportFor([
      result({
        id: "unknown-ownership#1",
        status: "failed",
        failure: {
          name: "HostNotOwnedError",
          message: "ownership could not be decided",
          ownership: { kind: "unknown", evidence: "no pid file" },
          lastOperations: [],
        },
      }),
    ]);

    expect(report.records[0]?.classification).toBe("unknown");
    expect(report.records[0]?.result).toBe("UNKNOWN");
    expect(report.records[0]?.catalogBinding).toBeNull();
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
    expect(report.records.map((record) => record.result)).toEqual([
      "UNKNOWN",
      "UNKNOWN",
      "UNKNOWN",
    ]);
    expect(report.records.every((record) => record.catalogBinding === null)).toBe(true);
  });

  it("does not promote a pass that never launched a session", () => {
    const report = reportFor([result({}, ["session"])]);
    const record = report.records[0];

    expect(record?.classification).toBe("unknown");
    expect(record?.result).toBe("UNKNOWN");
    expect(record?.catalogBinding).toBeNull();
    expect(record?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "session-not-launched" })]),
    );
    expect(report.ok).toBe(false);
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

describe("environment compatibility", () => {
  const row = {
    compatibility: {
      os: ["darwin"],
      architectures: ["arm64"],
      aeVersions: ["26.x"],
    },
  };

  it("evaluates os, arch and AE version independently", () => {
    expect(
      evaluateCompatibility(row, {
        os: "darwin",
        arch: "arm64",
        aeVersion: "26.0.0",
      }).verdict,
    ).toBe("compatible");
    expect(
      evaluateCompatibility(row, { os: "win32", arch: "arm64", aeVersion: "26.0.0" }).verdict,
    ).toBe("incompatible");
    expect(
      evaluateCompatibility(row, { os: "darwin", arch: "x64", aeVersion: "26.0.0" }).verdict,
    ).toBe("incompatible");
    expect(
      evaluateCompatibility(row, { os: "darwin", arch: "arm64", aeVersion: "25.9" }).verdict,
    ).toBe("incompatible");
  });

  it("treats an unobserved AE version as unknown, not incompatible", () => {
    const verdict = evaluateCompatibility(row, { os: "darwin", arch: "arm64" });
    expect(verdict.verdict).toBe("unknown");
    expect(verdict.reasons.join(" ")).toContain("ae version");
  });

  it("blocks only when every catalog-known capability is incompatible", () => {
    const catalog = loadCapabilityCatalog(
      resolve(import.meta.dirname, "..", "fixtures", "conformance", "capability-catalog.json"),
    );
    // All declared IDs are compatible with darwin/arm64 → no block.
    expect(
      environmentBlockReason(CAPABILITY_IDS, catalog, { os: "darwin", arch: "arm64" }),
    ).toBeUndefined();
    // Every ID declares win32-only → blocked on darwin.
    const win32Only = {
      ...catalog,
      records: new Map(
        CAPABILITY_IDS.map((id) => [
          id,
          { compatibility: { os: ["win32"], aeVersions: ["26.x"] } },
        ]),
      ),
    };
    expect(
      environmentBlockReason(CAPABILITY_IDS, win32Only, { os: "darwin", arch: "arm64" }),
    ).toContain("compatible with this environment");
    // A mix of compatible and incompatible still runs.
    const mixed = {
      ...catalog,
      records: new Map([
        ["ae.operation.render.frame", { compatibility: { os: ["win32"] } }],
        ["ae.operation.project.open", { compatibility: { os: ["darwin", "win32"] } }],
      ]),
    };
    expect(
      environmentBlockReason(
        ["ae.operation.render.frame", "ae.operation.project.open"],
        mixed,
        { os: "darwin", arch: "arm64" },
      ),
    ).toBeUndefined();
  });

  it("reports a capability incompatible with the observed AE version", () => {
    const catalogPath = join(dir, "catalog.json");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        schema: "ae-devtools.capability-catalog/v1",
        records: CAPABILITY_IDS.map((id) => ({
          id,
          compatibility:
            id === "ae.operation.render.frame"
              ? { os: ["darwin", "win32"], aeVersions: ["99.x"] }
              : { os: ["darwin", "win32"], aeVersions: ["26.x"] },
        })),
      }),
    );

    const report = reportFor(
      [
        result({
          capabilities: ["ae.operation.render.frame"],
          session: {
            uid: 501,
            asid: 1,
            ae: { version: "26.0.0" },
            extensions: [],
            fixtures: [],
            transport: "fake-in-process",
          },
        }),
      ],
      { catalogPath },
    );

    expect(report.records[0]?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "environment-incompatible",
          capabilityId: "ae.operation.render.frame",
        }),
      ]),
    );
    expect(report.ok).toBe(false);
  });
});

describe("evidence aggregation", () => {
  it("hashes plugin and SDK binaries into the report", () => {
    const pluginPath = join(dir, "effect.plugin");
    const sdkPath = join(dir, "ae-sdk.a");
    writeFileSync(pluginPath, "plugin-bytes");
    writeFileSync(sdkPath, "sdk-bytes");

    const report = reportFor([result()], {
      pluginBinaries: [pluginPath],
      sdkBinaries: [sdkPath, join(dir, "missing.bin")],
    });

    expect(report.binaries.plugin).toHaveLength(1);
    expect(report.binaries.plugin[0]?.sha256).toBe(
      createHash("sha256").update("plugin-bytes").digest("hex"),
    );
    expect(report.binaries.sdk).toHaveLength(2);
    expect(report.binaries.sdk[0]?.sha256).toBe(
      createHash("sha256").update("sdk-bytes").digest("hex"),
    );
    expect(report.binaries.sdk[1]?.sha256).toBeNull();
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "binary-unreadable" })]),
    );
  });

  it("groups records into an os × AE-version matrix", () => {
    const report = reportFor([
      result(),
      result({
        id: "spec#2",
        session: {
          uid: 501,
          asid: 1,
          ae: { version: "27.1", build: "3" },
          extensions: [],
          fixtures: [],
          transport: "fake-in-process",
        },
      }),
      result({ id: "spec#3", status: "skipped", durationMs: 0 }, ["session", "cleanup"]),
    ]);

    expect(report.summary.matrix).toHaveLength(3);
    const current = report.summary.matrix.find((cell) => cell.aeVersion === "26.5");
    expect(current?.total).toBe(1);
    expect(current?.byResult.PASS).toBe(1);
    const other = report.summary.matrix.find((cell) => cell.aeVersion === "27.1");
    expect(other?.total).toBe(1);
    const noSession = report.summary.matrix.find((cell) => cell.aeVersion === null);
    expect(noSession?.byResult.NOT_RUN).toBe(1);
  });
});

describe("capability catalog", () => {
  it("rejects a catalog with the wrong schema instead of guessing", () => {
    const catalogPath = join(dir, "catalog.json");
    writeFileSync(catalogPath, JSON.stringify({ schema: "other/v1", records: [] }));
    expect(() => loadCapabilityCatalog(catalogPath)).toThrow(/schema/);
  });

  it("loads the checked-in capability manifest with OS and AE rows", () => {
    const catalog = loadCapabilityCatalog(
      resolve(import.meta.dirname, "..", "fixtures", "conformance", "capability-catalog.json"),
    );

    expect(catalog.recordCount).toBe(CAPABILITY_IDS.length);
    for (const id of CAPABILITY_IDS) {
      expect(catalog.records.has(id)).toBe(true);
    }
    const render = catalog.records.get("ae.operation.render.frame") as
      | { compatibility?: { os?: string[]; aeVersions?: string[] } }
      | undefined;
    expect(render?.compatibility?.os).toEqual(expect.arrayContaining(["darwin", "win32"]));
    expect(render?.compatibility?.aeVersions).toEqual(expect.arrayContaining(["26.x"]));
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
    const pluginPath = join(dir, "effect.plugin");
    writeFileSync(pluginPath, "plugin-bytes");
    const resultsDir = join(dir, "results");

    const summary = await run({
      files: [SPEC],
      resultsDir,
      projectsDir: PROJECTS_DIR,
      transport: new FakeAfterEffectsTransport(),
      updateSnapshots: true,
      baselineDir: join(dir, "baselines"),
      conformance: {
        host: "fake",
        catalogPath,
        sourceSha: "deadbeef",
        runId: "vertical-slice",
        recordedAt: "2026-11-16T00:00:00.000Z",
        pluginBinaries: [pluginPath],
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
    expect(report.binaries.plugin).toHaveLength(1);
    expect(report.binaries.plugin[0]?.sha256).toBe(
      createHash("sha256").update("plugin-bytes").digest("hex"),
    );
    expect(report.summary.matrix.length).toBeGreaterThan(0);

    const runReport = JSON.parse(readFileSync(summary.reportPath, "utf-8")) as RunSummary;
    expect(runReport.conformancePath).toBe(summary.conformancePath);
    expect(runReport.conformanceOk).toBe(true);
    expect(summary.conformanceOk).toBe(true);
    expect(exitCodeFor(summary)).toBe(0);
  });

  it("makes a non-OK conformance report fail the run's exit status", async () => {
    const catalogPath = join(dir, "catalog.json");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        schema: "ae-devtools.capability-catalog/v1",
        records: [{ id: "ae.operation.project.open" }],
      }),
    );

    const summary = await run({
      files: [SPEC],
      resultsDir: join(dir, "results"),
      projectsDir: PROJECTS_DIR,
      transport: new FakeAfterEffectsTransport(),
      updateSnapshots: true,
      baselineDir: join(dir, "baselines"),
      conformance: {
        host: "fake",
        catalogPath,
        runId: "missing-capabilities",
      },
    });

    const report = JSON.parse(readFileSync(summary.conformancePath ?? "", "utf-8")) as ConformanceReport;
    expect(report.ok).toBe(false);
    expect(summary.conformanceOk).toBe(false);
    expect(exitCodeFor(summary)).toBe(1);
  });

  it("cannot promote a fake transport declared as a real host", async () => {
    // The public API lets a caller inject any transport and declare any
    // host. Provenance comes from the session's own handshake, not the
    // declaration: FakeAfterEffectsTransport reports "fake-in-process", so
    // every record stays fake-only and the mismatch fails the report.
    const summary = await run({
      files: [SPEC],
      resultsDir: join(dir, "results"),
      projectsDir: PROJECTS_DIR,
      transport: new FakeAfterEffectsTransport(),
      updateSnapshots: true,
      baselineDir: join(dir, "baselines"),
      conformance: { host: "real", runId: "declared-real" },
    });

    const report = JSON.parse(readFileSync(summary.conformancePath ?? "", "utf-8")) as ConformanceReport;
    expect(report.host).toBe("real");
    expect(report.records.length).toBeGreaterThan(0);
    expect(report.records.every((record) => record.classification === "fake-only")).toBe(true);
    expect(
      report.records.every((record) =>
        record.environment.transportKind === "fake-in-process",
      ),
    ).toBe(true);
    expect(
      report.diagnostics.filter((d) => d.code === "host-provenance-mismatch").length,
    ).toBe(report.records.length);
    expect(report.ok).toBe(false);
    expect(summary.conformanceOk).toBe(false);
    expect(exitCodeFor(summary)).toBe(1);
  });

  it("fails when a capability filter selects no tests", async () => {
    const summary = await run({
      files: [SPEC],
      resultsDir: join(dir, "results"),
      projectsDir: PROJECTS_DIR,
      transport: new FakeAfterEffectsTransport(),
      capabilityFilter: ["ae.operation.not.declared"],
      conformance: { host: "fake", runId: "empty-selection" },
    });

    expect(summary.results).toHaveLength(0);
    expect(summary.noTestsSelected).toBe(true);
    expect(summary.conformanceOk).toBe(false);
    expect(exitCodeFor(summary)).toBe(1);

    const report = JSON.parse(readFileSync(summary.conformancePath ?? "", "utf-8")) as ConformanceReport;
    expect(report.ok).toBe(false);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "no-tests-selected" })]),
    );
  });

  it("blocks tests whose capabilities are all incompatible with this OS", async () => {
    const catalogPath = join(dir, "catalog.json");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        schema: "ae-devtools.capability-catalog/v1",
        // "plan9" is never this host's os, on any platform CI runs.
        records: CAPABILITY_IDS.map((id) => ({
          id,
          compatibility: { os: ["plan9"], aeVersions: ["26.x"] },
        })),
      }),
    );

    const summary = await run({
      files: [SPEC],
      resultsDir: join(dir, "results"),
      projectsDir: PROJECTS_DIR,
      transport: new FakeAfterEffectsTransport(),
      conformance: { host: "fake", catalogPath, runId: "env-blocked" },
    });

    expect(summary.results.length).toBeGreaterThan(0);
    expect(summary.results.every((result) => result.status === "blocked")).toBe(true);
    expect(summary.results[0]?.blockedReason).toContain("compatible with this environment");
    expect(exitCodeFor(summary)).toBe(1);

    const report = JSON.parse(readFileSync(summary.conformancePath ?? "", "utf-8")) as ConformanceReport;
    expect(report.records.every((record) => record.classification === "blocked")).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("selects tests by declared capability ID", async () => {
    const summary = await run({
      files: [SPEC],
      resultsDir: join(dir, "results"),
      projectsDir: PROJECTS_DIR,
      transport: new FakeAfterEffectsTransport(),
      updateSnapshots: true,
      baselineDir: join(dir, "baselines"),
      capabilityFilter: ["ae.operation.render.frame"],
    });

    expect(summary.results.map((result) => result.title)).toEqual([
      "applies a plugin effect and renders a frame",
      "the parameter reaches the pixels",
    ]);
    expect(
      summary.results.every((result) =>
        result.capabilities.includes("ae.operation.render.frame"),
      ),
    ).toBe(true);
  });
});
