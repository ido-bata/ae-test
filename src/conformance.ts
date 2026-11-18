/**
 * Conformance evidence records.
 *
 * This is ae-test's producer side of the ae-devtools capability/evidence
 * contract (`specs/ae-capability-coverage/design/conformance-evidence.md` in
 * ae-devtools). It deliberately uses a mapped subset: immutable per-test
 * records, catalog IDs supplied by the spec, exact artifact hashes, and a
 * classification that never lets a fake-host pass read as real-host proof.
 *
 * The module is split by responsibility: conformance-types.ts holds the
 * record/report vocabulary, conformance-record.ts builds and classifies one
 * record, conformance-compat.ts evaluates catalog compatibility, and this
 * file assembles the run report. Everything the package exports is
 * re-exported here so `./conformance.js` remains the single import site.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { release } from "node:os";

import type { RunSummary } from "./types.js";
import { AE_TEST_VERSION } from "./version.js";
import { buildRecord } from "./conformance-record.js";
import {
  CAPABILITY_CATALOG_SCHEMA,
  CLASSIFICATION_ORDER,
  CONFORMANCE_REPORT_SCHEMA,
  RESULT_ORDER,
  ConformanceError,
  type CapabilityCatalogIndex,
  type ConformanceBinaryHash,
  type ConformanceDiagnostic,
  type ConformanceMatrixCell,
  type ConformanceRecord,
  type ConformanceReport,
  type ConformanceResult,
  type ConformanceRunOptions,
} from "./conformance-types.js";

export {
  CAPABILITY_CATALOG_SCHEMA,
  CONFORMANCE_RECORD_VERSION,
  CONFORMANCE_REPORT_SCHEMA,
  ConformanceError,
} from "./conformance-types.js";
export type {
  CapabilityCatalogIndex,
  CompatibilityEnvironment,
  CompatibilityVerdict,
  ConformanceArtifactHash,
  ConformanceBinaryHash,
  ConformanceCatalogSummary,
  ConformanceClassification,
  ConformanceDiagnostic,
  ConformanceHost,
  ConformanceMatrixCell,
  ConformanceRecord,
  ConformanceReport,
  ConformanceResult,
  ConformanceRunOptions,
  ConformanceVerification,
} from "./conformance-types.js";
export { environmentBlockReason, evaluateCompatibility } from "./conformance-compat.js";
export { hostProvenance } from "./conformance-record.js";
export type { HostProvenance } from "./conformance-record.js";

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

  // An empty selection is not evidence: a filter that matched nothing must
  // not read as a green run.
  if (records.length === 0) {
    diagnostics.push({
      severity: "error",
      code: "no-tests-selected",
      detail: "the run selected no tests; an empty selection proves nothing",
    });
  }

  const binaries = {
    plugin: hashBinaries(options.pluginBinaries ?? [], diagnostics),
    sdk: hashBinaries(options.sdkBinaries ?? [], diagnostics),
  };

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
      matrix: matrixCells(records),
    },
    binaries,
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

function emptyCounts<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function hashBinaries(
  paths: readonly string[],
  diagnostics: ConformanceDiagnostic[],
): ConformanceBinaryHash[] {
  return paths.map((path) => {
    const absolute = resolve(path);
    const entry: ConformanceBinaryHash = {
      name: basename(absolute),
      path: absolute,
      bytes: null,
      sha256: null,
    };
    try {
      const bytes = readFileSync(absolute);
      return {
        ...entry,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch {
      diagnostics.push({
        severity: "warning",
        code: "binary-unreadable",
        detail: `binary ${absolute} could not be read; its hash is recorded as null`,
      });
      return entry;
    }
  });
}

function matrixCells(records: readonly ConformanceRecord[]): ConformanceMatrixCell[] {
  const cells = new Map<
    string,
    {
      os: string;
      osVersion: string;
      arch: string;
      aeVersion: string | null;
      total: number;
      byResult: Record<ConformanceResult, number>;
    }
  >();
  for (const record of records) {
    const aeVersion = record.aeVersion?.version ?? null;
    const key = `${record.platform.os}${record.platform.osVersion}${record.platform.arch}${aeVersion ?? ""}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        os: record.platform.os,
        osVersion: record.platform.osVersion,
        arch: record.platform.arch,
        aeVersion,
        total: 0,
        byResult: emptyCounts(RESULT_ORDER),
      };
      cells.set(key, cell);
    }
    cell.total += 1;
    cell.byResult[record.result] += 1;
  }
  return [...cells.values()].sort((a, b) =>
    `${a.os}/${a.aeVersion ?? ""}`.localeCompare(`${b.os}/${b.aeVersion ?? ""}`),
  );
}
