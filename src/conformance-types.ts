/**
 * Conformance evidence record vocabulary: schema identifiers, the record and
 * report shapes, and the classification rules' shared ordering. Split from
 * conformance.ts so the producer (report building) and the classifiers each
 * depend on types without depending on each other.
 */
import type { FixtureDigest, TestResult } from "./types.js";

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

export const RESULT_ORDER: readonly ConformanceResult[] = [
  "NOT_RUN",
  "BLOCKED",
  "PASS",
  "FAIL",
  "UNKNOWN",
];

export const CLASSIFICATION_ORDER: readonly ConformanceClassification[] = [
  "unsupported",
  "refused",
  "unknown",
  "fake-only",
  "real-host-verified",
  "failed",
  "blocked",
  "not-run",
];
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
