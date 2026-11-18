/**
 * Release preconditions, checked before anything can be published.
 *
 *   node scripts/check-release.js [<tag>]
 *
 * - A pre-release version (x.y.z-anything) must publish under a non-default
 *   dist-tag ("next"), so `npm install @ido-bata/ae-test` never picks it up.
 * - A stable version publishes to `latest` — explicitly or by leaving
 *   publishConfig.tag unset — and nowhere else: a stable on `next` would
 *   leave `latest` pointing at an older release.
 * - Provenance stays off by decision: the repository is public now, so npm
 *   could attest; enabling it is its own reviewed change, not a version
 *   bump.
 * - A tag, when given, must be exactly `v<version>`.
 * - The exported AE_TEST_VERSION constant must equal the package version.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PRERELEASE, distTagFor, isEntryPoint } from "./release-tag.js";

/**
 * The release preconditions as data, so they can be tested without a
 * checkout: `manifest` is package.json's parsed content, `constant` is the
 * exported AE_TEST_VERSION (or undefined when no source declares it), and
 * `gitTag` is the pushed tag when the workflow supplies one.
 *
 * @param {{
 *   version: string,
 *   publishConfig?: { tag?: unknown, provenance?: unknown, access?: unknown },
 *   constant: string | undefined,
 *   gitTag?: string,
 * }} input
 * @returns {string[]} the problems found; empty means the release may proceed
 */
export function releaseProblems({ version, publishConfig, constant, gitTag }) {
  const problems = [];
  const prerelease = PRERELEASE.test(version);
  const tag = publishConfig?.tag;

  if (tag !== undefined && typeof tag !== "string") {
    problems.push(`publishConfig.tag must be a string, got ${JSON.stringify(tag)}`);
  }
  // distTagFor treats an empty string as unusable; reject it here too so the
  // gate and the staging step cannot disagree about the same manifest.
  if (tag === "") {
    problems.push(`publishConfig.tag must not be empty`);
  }
  if (prerelease && (tag === undefined || tag === "latest")) {
    problems.push(`pre-release ${version} must publish under a non-default dist-tag (publishConfig.tag), not ${tag === undefined ? "latest" : JSON.stringify(tag)}`);
  }
  if (!prerelease && tag !== undefined && tag !== "latest") {
    problems.push(`stable ${version} must publish under "latest" (or no publishConfig.tag), not ${JSON.stringify(tag)}`);
  }
  if (publishConfig?.provenance !== false) {
    problems.push("publishConfig.provenance must be false (provenance is off by decision; see docs/releasing.md)");
  }
  if (publishConfig?.access !== "public") {
    problems.push("publishConfig.access must be public for a scoped package");
  }
  if (constant !== version) {
    problems.push(`AE_TEST_VERSION is ${constant}, package.json says ${version}`);
  }
  if (gitTag !== undefined && gitTag !== "" && gitTag !== `v${version}`) {
    problems.push(`tag ${gitTag} does not match v${version}`);
  }
  return problems;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

  const versionSources = ["index.ts", "version.ts"]
    .map((name) => join(root, "src", name))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, "utf-8"));
  const constant = versionSources
    .map((source) => /export const AE_TEST_VERSION = "([^"]+)"/.exec(source)?.[1])
    .find((value) => value !== undefined);

  const problems = releaseProblems({
    version: manifest.version,
    publishConfig: manifest.publishConfig,
    constant,
    gitTag: process.argv[2],
  });

  const tag = distTagFor({ version: manifest.version, publishConfig: manifest.publishConfig }) ?? "?";
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
  }
  console.log(`${manifest.name}@${manifest.version} → dist-tag "${tag}"${process.argv[2] ? `, tag ${process.argv[2]}` : ""}: ok`);
}

if (isEntryPoint(import.meta.url)) {
  main();
}
