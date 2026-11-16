/**
 * Conformance evidence records.
 *
 * This is ae-test's producer side of the ae-devtools capability/evidence
 * contract (`specs/ae-capability-coverage/design/conformance-evidence.md` in
 * ae-devtools). It deliberately uses a mapped subset: immutable per-test
 * records, catalog IDs supplied by the spec, exact artifact hashes, and a
 * classification that never lets a fake-host pass read as real-host proof.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { release } from "node:os";

import type {
  ConformanceExpectation,
  FixtureDigest,
  RunSummary,
  TestResult,
} from "./types.js";
import { AE_TEST_VERSION } from "./version.js";

export const CONFORMANCE_REPORT_SCHEMA = "ae-test.conformance/v1";
export const CONFORMANCE_RECORD_VERSION = "ae-test.conformance-record/v1";
export const CAPABILITY_CATALOG_SCHEMA = "ae-devtools.capability-catalog/v1";

export type ConformanceHost = "fake" | "real";

/** Plan §6.2 matrix vocabulary; `unsupported`/`unknown` are never PASS. */
export type ConformanceResult = "NOT_RUN" | "BLOCKED" | "PASS" | "FAIL" | "UNKNOWN";

/**
 * What the record is allowed to claim. `fake-only` and `real-host-verified`
 * are the only promotable classes; every other class is honest non-proof.
 */
export type ConformanceClassification =
  | "unsupported"
  | "refused"
  | "unknown"
  | "fake-only"
  | "real-host-verified"
  | "failed"
  | "blocked"
  | "not-run";

export type ConformanceVerification = "not-run" | "automated-fake" | "verified-real-host";

export type ConformanceRunOptions = {
  /** `fake` is the ae-a8n fake host; `real` is an installed After Effects. */
  readonly host: ConformanceHost;
  /** ae-devtools `catalog.json`; capability IDs are checked against it. */
  readonly catalogPath?: string;
  /** Git SHA of the code under test. Defaults to SOURCE_SHA/GITHUB_SHA. */
  readonly sourceSha?: string;
  readonly runId?: string;
  /** Defaults to `<resultsDir>/conformance.json`. */
  readonly outPath?: string;
  /** Injectable for tests; defaults to now. */
  readonly recordedAt?: string;
  readonly packageVersion?: string;
};

export type ConformanceDiagnostic = {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly testId?: string;
  readonly capabilityId?: string;
  readonly detail: string;
};

export type ConformanceArtifactHash = {
  readonly name: string;
  readonly path: string;
  readonly kind: TestResult["artifacts"][number]["kind"];
  readonly bytes: number;
  readonly sha256: string | null;
};

export type ConformanceRecord = {
  readonly recordVersion: typeof CONFORMANCE_RECORD_VERSION;
  readonly id: string;
  readonly test: {
    readonly id: string;
    readonly title: string;
    readonly file: string;
    readonly status: TestResult["status"];
    readonly durationMs: number;
  };
  readonly capabilityIds: readonly string[];
  readonly platform: {
    readonly os: string;
    readonly osVersion: string;
    readonly arch: string;
  };
  readonly aeVersion: { readonly version: string; readonly build?: string } | null;
  readonly sdkBuild: null;
  readonly sdkBuildStatus: "not-applicable";
  readonly verification: ConformanceVerification;
  readonly result: ConformanceResult;
  readonly classification: ConformanceClassification;
  readonly catalogBinding:
    | {
        readonly kind: "automated-test" | "real-host";
        readonly ref: string;
        readonly platform?: "win32" | "darwin";
      }
    | null;
  readonly sourceSha: string | null;
  readonly sourceShaSource: "option" | "environment" | "unavailable";
  readonly runId: string;
  readonly artifactHashes: readonly ConformanceArtifactHash[];
  readonly environment: {
    readonly host: ConformanceHost;
    readonly session: "launched" | "not-launched";
    readonly disposableProject: boolean;
    readonly sideEffects: "none-observed" | "unproven" | "not-applicable";
    readonly cleanup: TestResult["cleanup"];
    readonly uid: number | null;
    readonly asid: number | null;
    readonly hostScriptExtensions: readonly string[];
    readonly fixtures: readonly FixtureDigest[];
  };
  readonly recordedAt: string;
  readonly failure?: {
    readonly name: string;
    readonly message: string;
    readonly phase?: string;
    readonly ownership?: { readonly kind: string; readonly evidence: string };
  };
  readonly diagnostics: readonly ConformanceDiagnostic[];
};

export type ConformanceCatalogSummary = {
  readonly path: string;
  readonly sha256: string;
  readonly schema: string;
  readonly recordCount: number;
};

export type ConformanceReport = {
  readonly schema: typeof CONFORMANCE_REPORT_SCHEMA;
  readonly generatedAt: string;
  readonly producer: {
    readonly name: "@ido-bata/ae-test";
    readonly version: string;
  };
  readonly sourceSha: string | null;
  readonly sourceShaSource: "option" | "environment" | "unavailable";
  readonly runId: string;
  readonly host: ConformanceHost;
  readonly run: {
    readonly resultsDir: string;
    readonly reportPath: string;
    readonly durationMs: number;
  };
  readonly catalog: ConformanceCatalogSummary | null;
  readonly summary: {
    readonly total: number;
    readonly byResult: Record<ConformanceResult, number>;
    readonly byClassification: Record<ConformanceClassification, number>;
  };
  readonly ok: boolean;
  readonly diagnostics: readonly ConformanceDiagnostic[];
  readonly records: readonly ConformanceRecord[];
};

export type CapabilityCatalogIndex = {
  readonly path: string;
  readonly sha256: string;
  readonly schema: string;
  readonly recordCount: number;
  readonly records: ReadonlyMap<string, unknown>;
};

export class ConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConformanceError";
  }
}

const RESULT_ORDER: readonly ConformanceResult[] = [
  "NOT_RUN",
  "BLOCKED",
  "PASS",
  "FAIL",
  "UNKNOWN",
];

const CLASSIFICATION_ORDER: readonly ConformanceClassification[] = [
  "unsupported",
  "refused",
  "unknown",
  "fake-only",
  "real-host-verified",
  "failed",
  "blocked",
  "not-run",
];

export function loadCapabilityCatalog(path: string): CapabilityCatalogIndex {
  const absolute = resolve(path);
  const bytes = readFileSync(absolute);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf-8"));
  } catch (error) {
    throw new ConformanceError(
      `capability catalog ${absolute} is not JSON: ${(error as Error).message}`,
    );
  }
  const schema = (parsed as { schema?: unknown }).schema;
  if (schema !== CAPABILITY_CATALOG_SCHEMA) {
    throw new ConformanceError(
      `capability catalog ${absolute} has schema ${String(schema)}, expected ${CAPABILITY_CATALOG_SCHEMA}`,
    );
  }
  const rows = (parsed as { records?: unknown }).records;
  if (!Array.isArray(rows)) {
    throw new ConformanceError(`capability catalog ${absolute} has no records array`);
  }
  const records = new Map<string, unknown>();
  for (const row of rows) {
    const id = (row as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) {
      records.set(id, row);
    }
  }
  return { path: absolute, sha256, schema, recordCount: records.size, records };
}

export function buildConformanceReport(
  summary: RunSummary,
  options: ConformanceRunOptions,
  catalog?: CapabilityCatalogIndex,
): ConformanceReport {
  const resolvedCatalog =
    catalog ?? (options.catalogPath === undefined ? undefined : loadCapabilityCatalog(options.catalogPath));
  const { sourceSha, sourceShaSource } = sourceShaFor(options);
  const runId = options.runId ?? `run-${Date.now().toString(36)}-${process.pid}`;
  const recordedAt = options.recordedAt ?? new Date().toISOString();
  const platform = {
    os: process.platform,
    osVersion: release(),
    arch: process.arch,
  };

  const records = summary.results.map((result) =>
    buildRecord(result, {
      host: options.host,
      catalog: resolvedCatalog,
      sourceSha,
      sourceShaSource,
      runId,
      recordedAt,
      platform,
    }),
  );

  const byResult = emptyCounts(RESULT_ORDER);
  const byClassification = emptyCounts(CLASSIFICATION_ORDER);
  const diagnostics: ConformanceDiagnostic[] = [];
  for (const record of records) {
    byResult[record.result] += 1;
    byClassification[record.classification] += 1;
    for (const diagnostic of record.diagnostics) {
      diagnostics.push({ ...diagnostic, testId: diagnostic.testId ?? record.test.id });
    }
  }

  const claimsWithoutCatalog =
    resolvedCatalog === undefined && summary.results.some((result) => result.capabilities.length > 0);
  if (claimsWithoutCatalog) {
    diagnostics.push({
      severity: "warning",
      code: "catalog-not-supplied",
      detail:
        "tests declare capability IDs but no catalog was supplied; IDs are recorded but not validated",
    });
  }

  const ok =
    summary.results.every((result) => result.status === "passed" || result.status === "skipped") &&
    diagnostics.every((diagnostic) => diagnostic.severity !== "error");

  return {
    schema: CONFORMANCE_REPORT_SCHEMA,
    generatedAt: recordedAt,
    producer: {
      name: "@ido-bata/ae-test",
      version: options.packageVersion ?? AE_TEST_VERSION,
    },
    sourceSha,
    sourceShaSource,
    runId,
    host: options.host,
    run: {
      resultsDir: summary.resultsDir,
      reportPath: summary.reportPath,
      durationMs: summary.durationMs,
    },
    catalog:
      resolvedCatalog === undefined
        ? null
        : {
            path: resolvedCatalog.path,
            sha256: resolvedCatalog.sha256,
            schema: resolvedCatalog.schema,
            recordCount: resolvedCatalog.recordCount,
          },
    summary: {
      total: records.length,
      byResult,
      byClassification,
    },
    ok,
    diagnostics,
    records,
  };
}

export function writeConformanceReport(
  summary: RunSummary,
  options: ConformanceRunOptions,
  catalog?: CapabilityCatalogIndex,
): { readonly path: string; readonly report: ConformanceReport } {
  const report = buildConformanceReport(summary, options, catalog);
  const path = resolve(options.outPath ?? join(summary.resultsDir, "conformance.json"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  return { path, report };
}

function buildRecord(
  result: TestResult,
  context: {
    host: ConformanceHost;
    catalog: CapabilityCatalogIndex | undefined;
    sourceSha: string | null;
    sourceShaSource: "option" | "environment" | "unavailable";
    runId: string;
    recordedAt: string;
    platform: { os: string; osVersion: string; arch: string };
  },
): ConformanceRecord {
  const id = `${context.runId}:${result.id}`;
  const diagnostics: ConformanceDiagnostic[] = [];
  const classified = classify(result, context.host);
  let { result: conformanceResult, classification } = classified;

  const unknownCapabilityIds =
    context.catalog === undefined
      ? []
      : result.capabilities.filter((capabilityId) => !context.catalog?.records.has(capabilityId));
  for (const capabilityId of unknownCapabilityIds) {
    diagnostics.push({
      severity: "error",
      code: "unknown-capability",
      capabilityId,
      detail: `capability ${capabilityId} is not in the supplied catalog`,
    });
  }
  if (
    unknownCapabilityIds.length > 0 &&
    (classification === "fake-only" || classification === "real-host-verified")
  ) {
    classification = "unknown";
    conformanceResult = "UNKNOWN";
  }

  const expectation = result.conformance ?? "pass";
  if (
    result.status !== "skipped" &&
    result.status !== "blocked" &&
    !expectationSatisfied(expectation, classification)
  ) {
    diagnostics.push({
      severity: "error",
      code: "conformance-expectation-mismatch",
      detail: `test declared conformance "${expectation}" but the record classifies as "${classification}"`,
    });
  }

  const verification = verificationFor(classification);
  const sessionLaunched = result.session !== undefined;
  const promotable = classification === "fake-only" || classification === "real-host-verified";
  const platform = evidencePlatform();

  return {
    recordVersion: CONFORMANCE_RECORD_VERSION,
    id,
    test: {
      id: result.id,
      title: result.title,
      file: result.file,
      status: result.status,
      durationMs: result.durationMs,
    },
    capabilityIds: result.capabilities,
    platform: context.platform,
    aeVersion: result.session?.ae ?? null,
    sdkBuild: null,
    sdkBuildStatus: "not-applicable",
    verification,
    result: conformanceResult,
    classification,
    catalogBinding: promotable
      ? {
          kind: classification === "real-host-verified" ? "real-host" : "automated-test",
          ref: id,
          ...(platform === undefined ? {} : { platform }),
        }
      : null,
    sourceSha: context.sourceSha,
    sourceShaSource: context.sourceShaSource,
    runId: context.runId,
    artifactHashes: artifactHashes(result),
    environment: {
      host: context.host,
      session: sessionLaunched ? "launched" : "not-launched",
      disposableProject: (result.session?.fixtures.length ?? 0) > 0,
      sideEffects:
        result.status === "passed" && result.cleanup?.status !== "failed"
          ? "none-observed"
          : result.session === undefined
            ? "not-applicable"
            : "unproven",
      cleanup: result.cleanup,
      uid: result.session?.uid ?? null,
      asid: result.session?.asid ?? null,
      hostScriptExtensions: result.session?.extensions ?? [],
      fixtures: result.session?.fixtures ?? [],
    },
    recordedAt: context.recordedAt,
    ...(result.failure === undefined
      ? {}
      : {
          failure: {
            name: result.failure.name,
            message: result.failure.message,
            ...(result.failure.phase === undefined ? {} : { phase: result.failure.phase }),
            ...(result.failure.ownership === undefined
              ? {}
              : { ownership: result.failure.ownership }),
          },
        }),
    diagnostics,
  };
}

function classify(
  result: TestResult,
  host: ConformanceHost,
): { result: ConformanceResult; classification: ConformanceClassification } {
  switch (result.status) {
    case "skipped":
      return { result: "NOT_RUN", classification: "not-run" };
    case "blocked":
      return { result: "BLOCKED", classification: "blocked" };
    case "timed-out":
      return { result: "UNKNOWN", classification: "unknown" };
    case "failed":
      if (isRefusal(result)) {
        return { result: "FAIL", classification: "refused" };
      }
      if (result.failure?.phase === "launch") {
        return { result: "UNKNOWN", classification: "unknown" };
      }
      return { result: "FAIL", classification: "failed" };
    case "passed": {
      const expectation = result.conformance ?? "pass";
      if (expectation === "unsupported") {
        return { result: "PASS", classification: "unsupported" };
      }
      if (expectation === "refused") {
        return { result: "PASS", classification: "refused" };
      }
      if (expectation === "unknown") {
        return { result: "PASS", classification: "unknown" };
      }
      return {
        result: "PASS",
        classification: host === "fake" ? "fake-only" : "real-host-verified",
      };
    }
  }
}

function isRefusal(result: TestResult): boolean {
  return (
    result.failure?.ownership !== undefined || result.failure?.name === "HostNotOwnedError"
  );
}

function expectationSatisfied(
  expectation: ConformanceExpectation,
  classification: ConformanceClassification,
): boolean {
  if (expectation === "pass") {
    return classification === "fake-only" || classification === "real-host-verified";
  }
  return classification === expectation;
}

function verificationFor(classification: ConformanceClassification): ConformanceVerification {
  if (classification === "fake-only") return "automated-fake";
  if (classification === "real-host-verified") return "verified-real-host";
  return "not-run";
}

function evidencePlatform(): "win32" | "darwin" | undefined {
  if (process.platform === "win32" || process.platform === "darwin") {
    return process.platform;
  }
  return undefined;
}

function sourceShaFor(options: ConformanceRunOptions): {
  sourceSha: string | null;
  sourceShaSource: "option" | "environment" | "unavailable";
} {
  if (options.sourceSha !== undefined && options.sourceSha.length > 0) {
    return { sourceSha: options.sourceSha, sourceShaSource: "option" };
  }
  const fromEnvironment = process.env.AE_TEST_SOURCE_SHA ?? process.env.SOURCE_SHA ?? process.env.GITHUB_SHA;
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) {
    return { sourceSha: fromEnvironment, sourceShaSource: "environment" };
  }
  return { sourceSha: null, sourceShaSource: "unavailable" };
}

function artifactHashes(result: TestResult): ConformanceArtifactHash[] {
  return result.artifacts.map((artifact) => {
    let sha256: string | null = null;
    try {
      sha256 = createHash("sha256").update(readFileSync(artifact.path)).digest("hex");
    } catch {
      sha256 = null;
    }
    return {
      name: artifact.name,
      path: artifact.path,
      kind: artifact.kind,
      bytes: artifact.bytes,
      sha256,
    };
  });
}

function emptyCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}
