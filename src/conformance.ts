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
import { basename, dirname, join, resolve } from "node:path";
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
  /**
   * Plugin binaries under test, as filesystem paths. Each is hashed into the
   * report so a consumer can apply the same-bytes rule; a path that cannot be
   * read is recorded with a null hash, never dropped.
   */
  readonly pluginBinaries?: readonly string[];
  /** SDK build artifacts under test, same hashing rule as `pluginBinaries`. */
  readonly sdkBinaries?: readonly string[];
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

/**
 * A plugin or SDK binary cited as evidence. `bytes`/`sha256` are null when the
 * file could not be read — the citation stays, the hash honestly absent.
 */
export type ConformanceBinaryHash = {
  readonly name: string;
  readonly path: string;
  readonly bytes: number | null;
  readonly sha256: string | null;
};

/** One cell of the os × AE-version acceptance matrix. */
export type ConformanceMatrixCell = {
  readonly os: string;
  readonly osVersion: string;
  readonly arch: string;
  /** Observed AE version, or null when no session reported one. */
  readonly aeVersion: string | null;
  readonly total: number;
  readonly byResult: Record<ConformanceResult, number>;
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
    readonly disposableProject: "yes" | "no" | "unknown";
    readonly sideEffects: "none-observed" | "unproven" | "not-applicable";
    readonly cleanup: TestResult["cleanup"];
    readonly uid: number | null;
    readonly asid: number | null;
    readonly hostScriptExtensions: readonly string[];
    readonly fixtures: readonly FixtureDigest[];
    /** The transport kind the session attested, or null when unproven. */
    readonly transportKind: string | null;
  };
  readonly recordedAt: string;
  readonly failure?: {
    readonly name: string;
    readonly message: string;
    readonly phase?: string;
    readonly ownership?: {
      readonly kind: string;
      readonly evidence: string;
      readonly quit?: boolean;
      readonly quitReason?: string;
      readonly closeError?: string;
    };
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
    /** Records grouped by observed os × AE version — the acceptance matrix. */
    readonly matrix: readonly ConformanceMatrixCell[];
  };
  /**
   * Plugin and SDK binaries the run cites as evidence, hashed for the
   * same-bytes rule. Empty lists mean none were supplied — which is itself
   * the honest answer for a run that tested no plugin binary.
   */
  readonly binaries: {
    readonly plugin: readonly ConformanceBinaryHash[];
    readonly sdk: readonly ConformanceBinaryHash[];
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
  const classified = classify(result);
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

  // A pass that never launched a session is not host evidence: it cannot be
  // fake-only or real-host-verified no matter which host the run targeted.
  if (
    result.status === "passed" &&
    (result.conformance ?? "pass") === "pass" &&
    result.session === undefined
  ) {
    diagnostics.push({
      severity: "error",
      code: "session-not-launched",
      detail:
        "test passed without launching a session; a pass with no host contact cannot be conformance evidence",
    });
  }

  // The declared host is a claim; the session's transport kind is the
  // evidence. A mismatch means the run cannot stand behind its declaration.
  if (result.session !== undefined) {
    const provenance = hostProvenance(result);
    if (provenance === "unknown") {
      diagnostics.push({
        severity: context.host === "real" ? "error" : "warning",
        code: "host-provenance-unknown",
        detail:
          "the session transport kind was not recognized; fake vs real host provenance is unproven",
      });
    } else if (provenance !== context.host) {
      diagnostics.push({
        severity: "error",
        code: "host-provenance-mismatch",
        detail: `run declared host "${context.host}" but the session transport is "${result.session.transport}" (${provenance})`,
      });
    }
  }

  // Catalog compatibility is checked against what the record actually
  // observed: this OS, this arch, this AE version/build. Dimensions the
  // catalog leaves open or the run could not measure stay silent. Skipped
  // tests are not evidence, so they carry no compatibility claim either.
  if (context.catalog !== undefined && result.status !== "skipped") {
    for (const capabilityId of result.capabilities) {
      const row = context.catalog.records.get(capabilityId);
      if (row === undefined) {
        continue;
      }
      const compatibility = evaluateCompatibility(row, {
        os: context.platform.os,
        arch: context.platform.arch,
        aeVersion: result.session?.ae?.version ?? null,
        aeBuild: result.session?.ae?.build ?? null,
      });
      if (compatibility.verdict === "incompatible") {
        diagnostics.push({
          severity: "error",
          code: "environment-incompatible",
          capabilityId,
          detail: `capability ${capabilityId} is not compatible with this environment: ${compatibility.reasons.join("; ")}`,
        });
      } else if (compatibility.verdict === "unknown") {
        diagnostics.push({
          severity: "warning",
          code: "environment-unverified",
          capabilityId,
          detail: `capability ${capabilityId} compatibility could not be fully evaluated: ${compatibility.reasons.join("; ")}`,
        });
      }
    }
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
      disposableProject: "unknown",
      sideEffects:
        context.host === "fake" || result.session === undefined
          ? "not-applicable"
          : "unproven",
      cleanup: result.cleanup,
      uid: result.session?.uid ?? null,
      asid: result.session?.asid ?? null,
      hostScriptExtensions: result.session?.extensions ?? [],
      fixtures: result.session?.fixtures ?? [],
      transportKind: result.session?.transport ?? null,
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

/**
 * Transport kinds ae-a8n reports through the capability handshake. Only the
 * built-in script transport is a real After Effects process; the in-process
 * fake is fake evidence; anything else — including a transport that cannot
 * say — has unproven provenance and must never promote.
 */
const REAL_TRANSPORT_KIND = "script-invocation";
const FAKE_TRANSPORT_KIND = "fake-in-process";

export type HostProvenance = "fake" | "real" | "unknown";

export function hostProvenance(result: TestResult): HostProvenance {
  const transport = result.session?.transport;
  if (transport === FAKE_TRANSPORT_KIND) return "fake";
  if (transport === REAL_TRANSPORT_KIND) return "real";
  return "unknown";
}

function classify(result: TestResult): {
  result: ConformanceResult;
  classification: ConformanceClassification;
} {
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
      if (isUnknownOwnership(result) || result.failure?.phase === "launch") {
        return { result: "UNKNOWN", classification: "unknown" };
      }
      return { result: "FAIL", classification: "failed" };
    case "passed": {
      const expectation = result.conformance ?? "pass";
      if (expectation === "pass") {
        // Promotable classes require a session that actually ran *and*
        // provenance the transport itself attests: a declared host is a
        // claim, not evidence, so an injected fake transport can never read
        // as real-host-verified.
        if (result.session === undefined) {
          return { result: "UNKNOWN", classification: "unknown" };
        }
        const provenance = hostProvenance(result);
        if (provenance === "unknown") {
          return { result: "UNKNOWN", classification: "unknown" };
        }
        return {
          result: "PASS",
          classification: provenance === "fake" ? "fake-only" : "real-host-verified",
        };
      }
      return { result: "UNKNOWN", classification: expectation };
    }
  }
}

function isRefusal(result: TestResult): boolean {
  return result.failure?.ownership?.kind === "attached";
}

function isUnknownOwnership(result: TestResult): boolean {
  return (
    result.failure?.ownership?.kind === "unknown" ||
    result.failure?.name === "HostNotOwnedError"
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

/** What the runner knows about the environment a capability would run in. */
export type CompatibilityEnvironment = {
  readonly os: string;
  readonly arch: string;
  /** Observed AE version; null/undefined when no session reported one. */
  readonly aeVersion?: string | null;
  /** Observed AE build number, same caveat. */
  readonly aeBuild?: string | null;
};

export type CompatibilityVerdict = {
  readonly verdict: "compatible" | "incompatible" | "unknown";
  readonly reasons: readonly string[];
};

/**
 * Evaluates one catalog row's `compatibility` block against an environment.
 *
 * `os`, `architectures`, `aeVersions` and `aeBuilds` are hard checks when the
 * catalog supplies them; `sdkVersions`, `requiredPlugins` and
 * `requiredPermissions` cannot be verified from here and only ever produce
 * `unknown`, never `incompatible`. A dimension the environment cannot supply
 * (no observed AE version) is `unknown`, not a failure — absence of evidence
 * is not evidence of incompatibility.
 */
export function evaluateCompatibility(
  row: unknown,
  env: CompatibilityEnvironment,
): CompatibilityVerdict {
  const compatibility = (row as { compatibility?: unknown }).compatibility;
  if (typeof compatibility !== "object" || compatibility === null) {
    return { verdict: "compatible", reasons: [] };
  }
  const compat = compatibility as Record<string, unknown>;
  const incompatible: string[] = [];
  const unknown: string[] = [];

  const listCheck = (
    field: string,
    observed: string | null | undefined,
    label: string,
  ): void => {
    const values = compat[field];
    if (!Array.isArray(values) || values.length === 0) {
      return;
    }
    const allowed = values.filter((value): value is string => typeof value === "string");
    if (allowed.length === 0) {
      return;
    }
    if (observed === null || observed === undefined || observed.length === 0) {
      unknown.push(`${label} not observed`);
      return;
    }
    const matched =
      field === "os" || field === "architectures"
        ? allowed.includes(observed)
        : allowed.some((pattern) => versionPatternMatches(pattern, observed));
    if (!matched) {
      incompatible.push(`${label} ${observed} is not in [${allowed.join(", ")}]`);
    }
  };

  listCheck("os", env.os, "os");
  listCheck("architectures", env.arch, "arch");
  listCheck("aeVersions", env.aeVersion, "ae version");
  listCheck("aeBuilds", env.aeBuild, "ae build");

  for (const field of ["sdkVersions", "requiredPlugins", "requiredPermissions"] as const) {
    const values = compat[field];
    if (Array.isArray(values) && values.length > 0) {
      unknown.push(`${field} cannot be verified locally`);
    }
  }

  if (incompatible.length > 0) {
    return { verdict: "incompatible", reasons: incompatible };
  }
  if (unknown.length > 0) {
    return { verdict: "unknown", reasons: unknown };
  }
  return { verdict: "compatible", reasons: [] };
}

/**
 * Dot-separated version pattern with `x`/`*` wildcards; the pattern matches a
 * prefix of the version, so `26.x` covers `26.0.0` and `26.5` covers `26.5.89`.
 */
function versionPatternMatches(pattern: string, version: string): boolean {
  const expected = pattern.trim().split(".");
  const actual = version.trim().split(".");
  if (expected.length > actual.length) {
    return false;
  }
  return expected.every(
    (segment, index) =>
      segment === "x" || segment === "X" || segment === "*" || segment === actual[index],
  );
}

/**
 * Whether a declaration should be kept out of this environment entirely:
 * every catalog-known capability it declares is hard-incompatible here.
 * Unknown catalog rows and unevaluable dimensions never block a run — they
 * surface as diagnostics on the records instead.
 */
export function environmentBlockReason(
  capabilityIds: readonly string[],
  catalog: CapabilityCatalogIndex,
  env: CompatibilityEnvironment,
): string | undefined {
  if (capabilityIds.length === 0) {
    return undefined;
  }
  const known = capabilityIds
    .map((id) => catalog.records.get(id))
    .filter((row): row is NonNullable<typeof row> => row !== undefined);
  if (known.length === 0) {
    return undefined;
  }
  const verdicts = known.map((row) => evaluateCompatibility(row, env));
  if (!verdicts.every((verdict) => verdict.verdict === "incompatible")) {
    return undefined;
  }
  const reasons = [...new Set(verdicts.flatMap((verdict) => verdict.reasons))];
  return `no declared capability is compatible with this environment (${env.os}/${env.arch}): ${reasons.join("; ")}`;
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
