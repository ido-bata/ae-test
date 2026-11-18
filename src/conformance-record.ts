/**
 * Per-test conformance record construction: transport provenance, the
 * status-to-classification mapping, and the record itself. The promotion
 * rules live here — a pass only becomes fake-only or real-host-verified when
 * the session's own transport attests which host ran it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ConformanceExpectation, TestResult } from "./types.js";
import { FAKE_TRANSPORT_KIND, REAL_TRANSPORT_KIND } from "./types.js";
import { evaluateCompatibility } from "./conformance-compat.js";
import {
  CONFORMANCE_RECORD_VERSION,
  type CapabilityCatalogIndex,
  type ConformanceArtifactHash,
  type ConformanceHost,
  type ConformanceClassification,
  type ConformanceDiagnostic,
  type ConformanceRecord,
  type ConformanceResult,
  type ConformanceVerification,
} from "./conformance-types.js";

/**
 * Transport kinds ae-a8n reports through the capability handshake. Only the
 * built-in script transport is a real After Effects process; the in-process
 * fake is fake evidence; anything else — including a transport that cannot
 * say — has unproven provenance and must never promote.
 */
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
    case "interrupted":
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

export function buildRecord(
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

  const catalog = context.catalog;
  // Session facts are attached even when the launch itself failed, so fact
  // presence is not evidence a session ran — only the launched flag is.
  const sessionLaunched = result.session?.launched === true;
  const unknownCapabilityIds =
    catalog === undefined
      ? []
      : result.capabilities.filter((capabilityId) => !catalog.records.has(capabilityId));
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
    !sessionLaunched
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
  // With no launched session there is no transport evidence to check.
  if (sessionLaunched) {
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
        detail: `run declared host "${context.host}" but the session transport is "${result.session?.transport}" (${provenance})`,
      });
    }
  }

  // Catalog compatibility is checked against what the record actually
  // observed: this OS, this arch, this AE version/build. Dimensions the
  // catalog leaves open or the run could not measure stay silent. Skipped
  // tests are not evidence, so they carry no compatibility claim either.
  if (catalog !== undefined && result.status !== "skipped") {
    for (const capabilityId of result.capabilities) {
      const row = catalog.records.get(capabilityId);
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
      // Only a launched session attests a transport; facts recorded for a
      // failed launch claim nothing about how a host would have run.
      transportKind: sessionLaunched ? (result.session?.transport ?? null) : null,
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
