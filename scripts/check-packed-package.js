/**
 * Verify the package from a consumer's position, against the fake host.
 *
 *   npm run build && node scripts/check-packed-package.js
 *
 * This repository's own specs import `../dist/index.js`, so they cannot notice
 * a broken exports map, a missing `bin`, or a dependency that only resolves
 * because of this checkout. So: pack, install the tarball into an empty
 * project (which pulls @ido-bata/ae-a8n from the registry, as a user would
 * get it), write a spec that imports `@ido-bata/ae-test` by name, and run it
 * through the installed `ae-test` binary:
 *
 * - a passing suite exits 0 and writes report.json with every test passed,
 *   plus a PNG and a trace per test that rendered;
 * - a failing suite exits 1, not 0 and not 2;
 * - no test file exits 2.
 *
 * This proves the package works with the fake host. It says nothing about a
 * real After Effects; see docs/verification.md for that.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

/** @param {string} message */
function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const workdir = mkdtempSync(join(tmpdir(), "ae-test-packed-"));
let tarball;
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", workdir], { cwd: ROOT, encoding: "utf-8" }));
  const entry = packed[0];
  tarball = join(workdir, entry.filename);
  const files = entry.files.map((/** @type {{ path: string }} */ f) => f.path);
  for (const required of ["dist/index.js", "dist/index.d.ts", "dist/cli.js", "LICENSE", "README.md", "CHANGELOG.md"]) {
    if (!files.includes(required)) fail(`${required} is not in the tarball`);
  }
  const unexpected = files.filter((/** @type {string} */ f) => /\.map$|^src\/|^test\/|^specs\/|^fixtures\//.test(f));
  if (unexpected.length > 0) fail(`unexpected files in the tarball: ${unexpected.join(", ")}`);
  console.log(`packed ${entry.id}: ${files.length} files, shasum ${entry.shasum}`);

  const project = join(workdir, "consumer");
  mkdirSync(join(project, "fixtures"), { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: project, stdio: "inherit" });
  // The fake host only needs the path to exist.
  writeFileSync(join(project, "fixtures", "fixture.aep"), "placeholder");

  const a8n = JSON.parse(readFileSync(join(project, "node_modules", "@ido-bata", "ae-a8n", "package.json"), "utf-8"));
  if (a8n.version !== manifest.dependencies["@ido-bata/ae-a8n"]) {
    fail(`installed @ido-bata/ae-a8n ${a8n.version}, package.json pins ${manifest.dependencies["@ido-bata/ae-a8n"]}`);
  }

  writeFileSync(
    join(project, "passing.spec.mjs"),
    `import { test, AE_TEST_VERSION } from "@ido-bata/ae-test";
test("renders through the installed package", async ({ ae, fixture, expect, expectFrame }) => {
  expect(AE_TEST_VERSION).toBe(${JSON.stringify(manifest.version)});
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const comp = await project.comp("Main");
  const effect = await (await comp.layer("Solid 1")).effects.apply("ADBE Fake Gaussian Blur");
  await effect.parameter("Amount").set(10);
  const frame = await comp.renderFrame(0);
  expectFrame(frame).toPath(/\\.png$/);
});
test("a typed failure is assertable", async ({ ae, fixture, expect }) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  await (await expect(project.comp("Missing")).rejects()).toMatchObject({ name: "EntityNotFoundError" });
});
`,
  );
  writeFileSync(
    join(project, "failing.spec.mjs"),
    `import { test } from "@ido-bata/ae-test";
test("fails on purpose", async ({ expect }) => { expect(1).toBe(2); });
`,
  );

  const bin = join(project, "node_modules", ".bin", "ae-test");
  /** @param {string[]} args */
  const cli = (args) => spawnSync(bin, args, { cwd: project, encoding: "utf-8" });

  const passing = cli(["passing.spec.mjs", "--fake-host", "--results-dir", "results"]);
  if (passing.status !== 0) fail(`passing suite exited ${passing.status}\n${passing.stdout}\n${passing.stderr}`);
  const report = JSON.parse(readFileSync(join(project, "results", "report.json"), "utf-8"));
  const statuses = report.results.map((/** @type {{ status: string }} */ r) => r.status);
  if (statuses.length !== 2 || statuses.some((/** @type {string} */ s) => s !== "passed")) {
    fail(`passing suite reported ${JSON.stringify(statuses)}`);
  }
  const rendered = report.results[0].artifacts.map((/** @type {{ kind: string }} */ a) => a.kind);
  if (!rendered.includes("render") || !rendered.includes("trace")) {
    fail(`the rendering test collected ${JSON.stringify(rendered)}, expected a render and a trace`);
  }
  for (const artifact of report.results[0].artifacts) {
    if (!existsSync(artifact.path)) fail(`artifact ${artifact.path} is in the report but not on disk`);
  }

  const failing = cli(["failing.spec.mjs", "--fake-host", "--results-dir", "results-failing"]);
  if (failing.status !== 1) fail(`failing suite exited ${failing.status}, expected 1`);

  const none = cli([]);
  if (none.status !== 2) fail(`no test files exited ${none.status}, expected 2`);

  console.log(
    `consumer install ok: ae-a8n ${a8n.version} from the registry; ` +
      `passing suite 0 (${readdirSync(join(project, "results")).length} entries in results/), failing suite 1, no files 2`,
  );
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
