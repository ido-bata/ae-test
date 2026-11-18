/**
 * Mirrors one npmjs-published version to GitHub Packages' npm registry, so
 * the package also appears on the repository's Packages tab. npmjs.com stays
 * the canonical distribution; this only copies what is already live there.
 *
 *   node scripts/sync-github-packages.js <version> [--dry-run]
 *
 * Guards, in order:
 * - the version must exist on registry.npmjs.org — a version that was never
 *   published to npmjs is never published here (issue #23);
 * - if the version already exists on npm.pkg.github.com the run is a no-op,
 *   so re-running after a partial failure is safe;
 * - the tarball is `npm pack` of the *published* npmjs version, so the two
 *   registries serve byte-identical content by construction.
 *
 * Authentication is ambient npm auth (NODE_AUTH_TOKEN / .npmrc), the same
 * contract as every other npm call in this repo: the publish workflow passes
 * GITHUB_TOKEN with packages:write; a local run uses a token with
 * write:packages. The script never sees or logs a token.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isEntryPoint } from "./release-tag.js";
import { NPMJS_REGISTRY, resolveNpmCli, runNpm } from "./stage-publish.js";

export const GITHUB_PACKAGES_REGISTRY = "https://npm.pkg.github.com";
export const PACKAGE_NAME = "@ido-bata/ae-test";

// A scoped `@<scope>:registry` in .npmrc beats the generic --registry flag,
// so every registry-targeted call pins the scope registry through the
// environment as well.
const SCOPE = PACKAGE_NAME.split("/")[0];

/** @param {string} registry */
function registryEnv(registry) {
  return { [`npm_config_${SCOPE}:registry`]: registry };
}

/**
 * What the sync should do for one version, given registry facts.
 *
 * @param {string} version
 * @param {{ onNpmjs: boolean, onGithub: boolean }} facts
 * @returns {{ action: "refuse" | "skip" | "publish", reason: string }}
 */
export function plan(version, facts) {
  if (!facts.onNpmjs) {
    return {
      action: "refuse",
      reason: `${PACKAGE_NAME}@${version} is not on npmjs; GitHub Packages mirrors published versions only`,
    };
  }
  if (facts.onGithub) {
    return { action: "skip", reason: `${PACKAGE_NAME}@${version} is already on GitHub Packages` };
  }
  return { action: "publish", reason: `${PACKAGE_NAME}@${version} will be mirrored to GitHub Packages` };
}

/**
 * Asks one registry whether the version exists, returning its
 * dist.integrity. The answer is only trusted when the reported tarball is
 * actually hosted on the registry that was asked: a scoped-registry
 * redirect would otherwise report the other registry's facts as this one's.
 *
 * @param {string} cli
 * @param {string} registry
 * @param {string} version
 */
function registryInfo(cli, registry, version) {
  const result = runNpm(
    cli,
    [
      "view",
      `${PACKAGE_NAME}@${version}`,
      "dist.integrity",
      "dist.tarball",
      "--registry",
      registry,
      "--json",
    ],
    registryEnv(registry),
  );
  if (result.status !== 0 || result.stdout.trim() === "") {
    return { present: false, integrity: /** @type {string | undefined} */ (undefined) };
  }
  /** @type {{ "dist.integrity"?: string, "dist.tarball"?: string }} */
  const data = JSON.parse(result.stdout);
  const tarball = data["dist.tarball"];
  const host = new URL(registry).host;
  if (typeof tarball !== "string" || new URL(tarball).host !== host) {
    fail(
      `${PACKAGE_NAME}@${version}: ${registry} answered but its tarball is hosted at ${tarball ?? "an unknown URL"}; a scoped registry setting redirected the query — fix @${SCOPE.slice(1)}:registry in .npmrc`,
    );
  }
  return {
    present: true,
    integrity: typeof data["dist.integrity"] === "string" ? data["dist.integrity"] : undefined,
  };
}

function fail(message) {
  // Throw, not process.exit: callers inside main()'s try/finally rely on the
  // throw to reach the cleanup before the entry-point guard reports it.
  throw new Error(message);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const unknown = args.filter((arg) => arg.startsWith("--") && arg !== "--dry-run");
  if (unknown.length > 0) {
    fail(`unknown argument ${unknown[0]}`);
  }
  const version = args.find((arg) => !arg.startsWith("--"));
  if (version === undefined || !/^\d+\.\d+\.\d+/.test(version)) {
    fail("usage: sync-github-packages.js <version> [--dry-run]");
  }

  const resolved = resolveNpmCli();
  if (!resolved.ok) {
    fail(resolved.error);
  }
  const cli = resolved.cli;

  const npmjs = registryInfo(cli, NPMJS_REGISTRY, version);
  const github = registryInfo(cli, GITHUB_PACKAGES_REGISTRY, version);
  const decision = plan(version, { onNpmjs: npmjs.present, onGithub: github.present });
  console.log(decision.reason);
  if (decision.action === "refuse") {
    fail(decision.reason);
  }
  if (decision.action === "skip") {
    // "Already mirrored" is only true when the mirrored bytes are the
    // published bytes; a divergent copy must not pass silently.
    if (
      npmjs.integrity !== undefined &&
      github.integrity !== undefined &&
      npmjs.integrity !== github.integrity
    ) {
      fail(
        `${PACKAGE_NAME}@${version} exists on both registries with different dist.integrity (${npmjs.integrity} on npmjs, ${github.integrity} on GitHub Packages); refusing to treat the mirror as current`,
      );
    }
    return;
  }
  if (dryRun) {
    console.log("dry run: nothing published");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "ae-test-ghpkg-"));
  try {
    const expected = npmjs.integrity;
    if (expected === undefined || !expected.startsWith("sha512-")) {
      fail(`npmjs reports no usable dist.integrity for ${PACKAGE_NAME}@${version}`);
    }

    // Pin the registry the existence check used: without it `npm pack` could
    // resolve the spec against an ambient mirror and publish bytes that are
    // not the npmjs artifact.
    const packed = runNpm(
      cli,
      [
        "pack",
        `${PACKAGE_NAME}@${version}`,
        "--registry",
        NPMJS_REGISTRY,
        "--pack-destination",
        dir,
        "--json",
      ],
      registryEnv(NPMJS_REGISTRY),
    );
    if (packed.status !== 0) {
      fail(`npm pack failed: ${packed.stderr.trim()}`);
    }
    const entries = JSON.parse(packed.stdout);
    const tarball = Array.isArray(entries) ? entries[0]?.filename : undefined;
    const actual = Array.isArray(entries) ? entries[0]?.integrity : undefined;
    if (typeof tarball !== "string" || typeof actual !== "string") {
      fail(`npm pack produced no tarball in ${dir}`);
    }
    if (actual !== expected) {
      fail(
        `packed tarball integrity ${actual} does not match npmjs dist.integrity ${expected}; refusing to mirror bytes that are not the published artifact`,
      );
    }
    const published = runNpm(
      cli,
      ["publish", join(dir, tarball), "--registry", GITHUB_PACKAGES_REGISTRY],
      registryEnv(GITHUB_PACKAGES_REGISTRY),
    );
    if (published.status !== 0) {
      fail(`npm publish to GitHub Packages failed: ${published.stderr.trim()}`);
    }
    console.log(published.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (isEntryPoint(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
