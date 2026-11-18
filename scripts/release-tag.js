/**
 * The release dist-tag policy, shared by check-release.js (the gate) and
 * stage-publish.js (the staging step) so the two can never disagree about
 * the same manifest.
 *
 * A pre-release version (x.y.z-anything) must publish under a non-default
 * dist-tag ("next"), so `npm install @ido-bata/ae-test` never picks it up.
 * A stable version publishes to `latest` — explicitly or by leaving
 * publishConfig.tag unset — and nowhere else: a stable on `next` would
 * leave `latest` pointing at an older release.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PRERELEASE = /^\d+\.\d+\.\d+-.+$/;

/**
 * The dist-tag a manifest publishes under: `publishConfig.tag`, or npm's
 * default `latest` when the field is absent (`undefined`). An explicitly
 * present but unusable value — `null`, a number, an empty string — returns
 * null rather than silently falling back, matching check-release.js's
 * rejection of non-string tags.
 *
 * @param {{ version?: string, publishConfig?: { tag?: unknown } }} manifest
 * @returns {string | null}
 */
export function distTagFor(manifest) {
  const raw = manifest.publishConfig?.tag;
  const tag = raw === undefined ? "latest" : raw;
  return typeof tag === "string" && tag !== "" ? tag : null;
}

/**
 * The tag a version must publish under, or an error describing the
 * violation.
 *
 * @param {{ version: string, publishConfig?: { tag?: unknown } }} manifest
 * @returns {{ ok: true, tag: string } | { ok: false, error: string }}
 */
export function checkDistTag(manifest) {
  const tag = distTagFor(manifest);
  if (tag === null) {
    return { ok: false, error: `publishConfig.tag is ${JSON.stringify(manifest.publishConfig?.tag)}, not a usable dist-tag` };
  }
  const prerelease = PRERELEASE.test(manifest.version);
  if (prerelease && tag === "latest") {
    return { ok: false, error: `pre-release ${manifest.version} must not publish to latest; set publishConfig.tag (e.g. "next")` };
  }
  if (!prerelease && tag !== "latest") {
    return { ok: false, error: `stable ${manifest.version} must publish to latest, not ${tag}` };
  }
  return { ok: true, tag };
}

/**
 * Entry-point guard shared by the release scripts: true only when the
 * script Node was asked to run is this module's caller. Compares realpaths
 * so a symlinked checkout still matches, while a different file invoked
 * through a symlink does not accidentally run main().
 *
 * @param {string} moduleUrl import.meta.url of the calling module
 */
export function isEntryPoint(moduleUrl) {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
