/**
 * Catalog compatibility evaluation: whether a capability row's declared
 * constraints hold in the environment a run observed. Pure functions over
 * catalog rows and measured facts — no I/O.
 */
import type {
  CapabilityCatalogIndex,
  CompatibilityEnvironment,
  CompatibilityVerdict,
} from "./conformance-types.js";

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
