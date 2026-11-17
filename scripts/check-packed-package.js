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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  writeFileSync(join(project, "catalog.json"), JSON.stringify({
    schema: "ae-devtools.capability-catalog/v1",
    records: [{ id: "ae.operation.project.open" }, { id: "ae.operation.render.frame" }],
  }));
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
  const again = await comp.renderFrame(0);
  await expectFrame(again).toMatchFrame(frame);
  await expectFrame(frame).toMatchSnapshot("main-frame-0");
}, { capabilities: ["ae.operation.project.open", "ae.operation.render.frame"] });
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

  // A consumer project can also be configured once and discovered: the config
  // selects the suite directory and the fake host, so bare `ae-test` runs it.
  mkdirSync(join(project, "suite"), { recursive: true });
  writeFileSync(
    join(project, "suite", "discovered.spec.mjs"),
    readFileSync(join(project, "passing.spec.mjs"), "utf-8"),
  );
  writeFileSync(
    join(project, "ae-test.config.json"),
    JSON.stringify({
      specs: ["suite/**/*.spec.mjs"],
      host: "fake",
      resultsDir: "results-config",
      baselineDir: "baselines-config",
    }),
  );

  // The packed types must compile for a consumer: every public name and the
  // shapes specs rely on, imported by package name exactly as a user would.
  writeFileSync(
    join(project, "types-check.ts"),
    `import {
  AE_TEST_VERSION, AssertionError, AsyncExpectation, CAPABILITY_CATALOG_SCHEMA,
  CONFIG_FILE_NAME, CONFORMANCE_RECORD_VERSION, CONFORMANCE_REPORT_SCHEMA,
  ConfigError, ConformanceError, DEFAULT_BASELINE_DIR, DEFAULT_RESULTS_DIR,
  DEFAULT_SPEC_PATTERNS, DEFAULT_TIMEOUT_MS, HostNotOwnedError, SnapshotStore,
  TestFixture, buildConformanceReport, clearRegistry, countByStatus, discoverSpecs,
  environmentBlockReason, evaluateCompatibility, exitCodeFor, expect, expectFrame,
  findConfigFile, formatFailure, formatResultLine, formatRun, formatSummary,
  hasFailures, hostProvenance, loadCapabilityCatalog, loadConfigFile, loadTestFiles,
  registeredTests, run, setDeclaringFile, skip, test, toMatchObject,
  writeConformanceReport,
} from "@ido-bata/ae-test";
import type {
  AeTestConfig, AeTestHost, Artifact, CapabilityCatalogIndex, CompatibilityEnvironment,
  CompatibilityVerdict, ConformanceArtifactHash, ConformanceBinaryHash,
  ConformanceCatalogSummary, ConformanceClassification, ConformanceDiagnostic,
  ConformanceExpectation, ConformanceHost, ConformanceMatrixCell, ConformanceRecord,
  ConformanceReport, ConformanceResult, ConformanceRunOptions, ConformanceVerification,
  Fixture, FixtureDigest, FixtureOptions, HostProvenance, ImageComparisonOptions,
  ImageDifference, LoadedConfig, RenderedFrame, RunOptions, RunSummary, SessionFacts,
  SnapshotStoreOptions, TestContext, TestDeclaration, TestFailure, TestFn, TestInfo,
  TestOptions, TestResult, TestStatus,
} from "@ido-bata/ae-test";

const options: RunOptions = {
  files: ["spec.mjs"],
  signal: undefined,
  teardownTimeoutMs: 30_000,
  drainTimeoutMs: 5_000,
};
const config: AeTestConfig = { host: "fake", specs: ["specs/**/*.spec.mjs"] };
const loaded: LoadedConfig | undefined = undefined;
void AE_TEST_VERSION;
void AssertionError; void AsyncExpectation; void CAPABILITY_CATALOG_SCHEMA;
void CONFIG_FILE_NAME; void CONFORMANCE_RECORD_VERSION; void CONFORMANCE_REPORT_SCHEMA;
void ConfigError; void ConformanceError; void DEFAULT_BASELINE_DIR;
void DEFAULT_RESULTS_DIR; void DEFAULT_SPEC_PATTERNS; void DEFAULT_TIMEOUT_MS;
void HostNotOwnedError; void SnapshotStore; void TestFixture;
void buildConformanceReport; void clearRegistry; void countByStatus; void discoverSpecs;
void environmentBlockReason; void evaluateCompatibility; void exitCodeFor; void expect;
void expectFrame; void findConfigFile; void formatFailure; void formatResultLine;
void formatRun; void formatSummary; void hasFailures; void hostProvenance;
void loadCapabilityCatalog; void loadConfigFile; void loadTestFiles;
void registeredTests; void run; void setDeclaringFile; void skip; void test;
void toMatchObject; void writeConformanceReport;
void options; void config; void loaded;
`,
  );
  const tsc = join(ROOT, "node_modules", ".bin", "tsc");
  const typecheck = spawnSync(
    tsc,
    [
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--target",
      "es2022",
      "types-check.ts",
    ],
    { cwd: project, encoding: "utf-8" },
  );
  if (typecheck.status !== 0) {
    fail(`packed types failed to compile for a consumer\n${typecheck.stdout}\n${typecheck.stderr}`);
  }

  const bin = join(project, "node_modules", ".bin", "ae-test");
  /** @param {string[]} args */
  const cli = (args) => spawnSync(bin, args, { cwd: project, encoding: "utf-8" });
  /** @param {string} dir @param {string[]} args */
  const cliIn = (cwd, args) => spawnSync(bin, args, { cwd, encoding: "utf-8" });

  // The programmatic surface works from the installed package too, not only
  // the CLI: `run()` with an injected fake transport, end to end.
  writeFileSync(
    join(project, "api-check.mjs"),
    `import { run } from "@ido-bata/ae-test";
import { FakeAfterEffectsTransport } from "@ido-bata/ae-a8n/testing";
const summary = await run({
  files: ["passing.spec.mjs"],
  resultsDir: "results-api",
  baselineDir: "baselines-api",
  projectsDir: "fixtures",
  transport: new FakeAfterEffectsTransport(),
  updateSnapshots: true,
});
if (summary.schema !== "ae-test.report/v1") {
  console.error("unexpected report schema: " + summary.schema);
  process.exit(1);
}
if (summary.results.length !== 2 || summary.results.some((r) => r.status !== "passed")) {
  console.error("programmatic run did not pass: " + JSON.stringify(summary.results.map((r) => r.status)));
  process.exit(1);
}
`,
  );
  const apiRun = spawnSync(process.execPath, ["api-check.mjs"], { cwd: project, encoding: "utf-8" });
  if (apiRun.status !== 0) {
    fail(`programmatic API run exited ${apiRun.status}\n${apiRun.stdout}\n${apiRun.stderr}`);
  }

  const passing = cli([
    "passing.spec.mjs",
    "--fake-host",
    "--results-dir",
    "results",
    "--baseline-dir",
    "baselines",
    "--update-snapshots",
    "--conformance",
    "--capability-catalog",
    "catalog.json",
    "--source-sha",
    "packed",
    "--run-id",
    "packed",
  ]);
  if (passing.status !== 0) fail(`passing suite exited ${passing.status}\n${passing.stdout}\n${passing.stderr}`);
  const report = JSON.parse(readFileSync(join(project, "results", "report.json"), "utf-8"));
  if (report.schema !== "ae-test.report/v1") {
    fail(`report.json schema is ${JSON.stringify(report.schema)}, expected ae-test.report/v1`);
  }
  const statuses = report.results.map((/** @type {{ status: string }} */ r) => r.status);
  if (statuses.length !== 2 || statuses.some((/** @type {string} */ s) => s !== "passed")) {
    fail(`passing suite reported ${JSON.stringify(statuses)}`);
  }
  const conformance = JSON.parse(readFileSync(join(project, "results", "conformance.json"), "utf-8"));
  if (conformance.schema !== "ae-test.conformance/v1") {
    fail(`conformance.json schema is ${JSON.stringify(conformance.schema)}, expected ae-test.conformance/v1`);
  }
  if (conformance.ok !== true || conformance.host !== "fake") {
    fail(`conformance report was not an ok fake-host report: ${JSON.stringify(conformance.summary)}`);
  }
  if (conformance.records.some((/** @type {{ classification: string }} */ r) => r.classification !== "fake-only")) {
    fail("packed consumer conformance records were not all fake-only");
  }
  const rendered = report.results[0].artifacts.map((/** @type {{ kind: string }} */ a) => a.kind);
  if (!rendered.includes("render") || !rendered.includes("trace")) {
    fail(`the rendering test collected ${JSON.stringify(rendered)}, expected a render and a trace`);
  }
  for (const artifact of report.results[0].artifacts) {
    if (!existsSync(artifact.path)) fail(`artifact ${artifact.path} is in the report but not on disk`);
  }
  // The snapshot baseline landed in the committed tree, namespaced by
  // environment — not inside the results directory.
  const baselineEnv = join(project, "baselines", "fake-in-process");
  const baselineFiles = existsSync(baselineEnv) ? readdirSync(baselineEnv) : [];
  if (!baselineFiles.some((name) => name.endsWith(".sha256")) ||
      !baselineFiles.some((name) => name.endsWith(".png"))) {
    fail(`no snapshot baseline under ${baselineEnv}: ${JSON.stringify(baselineFiles)}`);
  }
  if (existsSync(join(project, "results", "__snapshots__"))) {
    fail("baselines were written inside the results directory");
  }

  const failing = cli(["failing.spec.mjs", "--fake-host", "--results-dir", "results-failing"]);
  if (failing.status !== 1) fail(`failing suite exited ${failing.status}, expected 1`);

  // A failed pixel comparison leaves diff evidence: image copies, a diff PNG
  // and a JSON diagnostic, all listed as `diff` artifacts in the report.
  writeFileSync(
    join(project, "diff.spec.mjs"),
    `import { test } from "@ido-bata/ae-test";
test("two renders diverge", async ({ ae, fixture, expectFrame }) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const comp = await project.comp("Main");
  const effect = await (await comp.layer("Solid 1")).effects.apply("ADBE Fake Gaussian Blur");
  await effect.parameter("Amount").set(10);
  const low = await comp.renderFrame(0, { subdirectory: "low" });
  await expectFrame(low).toMatchSnapshot("low", { threshold: 0 });
  await effect.parameter("Amount").set(90);
  const high = await comp.renderFrame(0, { subdirectory: "high" });
  await expectFrame(high).toMatchSnapshot("high", { threshold: 0 });
});
`,
  );
  const recordDiff = cli([
    "diff.spec.mjs",
    "--fake-host",
    "--results-dir",
    "results-diff",
    "--baseline-dir",
    "baselines-diff",
    "--update-snapshots",
  ]);
  if (recordDiff.status !== 0) {
    fail(`diff baseline run exited ${recordDiff.status}\n${recordDiff.stdout}\n${recordDiff.stderr}`);
  }
  // Corrupt the "high" baseline with the "low" render so the pixel comparison
  // fails on the next run.
  const diffEnv = join(project, "baselines-diff", "fake-in-process");
  const lowPng = readdirSync(diffEnv).find((name) => name.endsWith("--low.png"));
  const highPng = readdirSync(diffEnv).find((name) => name.endsWith("--high.png"));
  if (lowPng === undefined || highPng === undefined) {
    fail(`diff baselines not recorded under ${diffEnv}`);
  }
  copyFileSync(join(diffEnv, lowPng), join(diffEnv, highPng));
  copyFileSync(
    join(diffEnv, lowPng.replace(/\.png$/, ".sha256")),
    join(diffEnv, highPng.replace(/\.png$/, ".sha256")),
  );
  const diffRun = cli([
    "diff.spec.mjs",
    "--fake-host",
    "--results-dir",
    "results-diff-2",
    "--baseline-dir",
    "baselines-diff",
  ]);
  if (diffRun.status !== 1) {
    fail(`diff suite exited ${diffRun.status}, expected 1\n${diffRun.stdout}\n${diffRun.stderr}`);
  }
  const diffReport = JSON.parse(
    readFileSync(join(project, "results-diff-2", "report.json"), "utf-8"),
  );
  const diffResult = diffReport.results.find(
    (/** @type {{ status: string }} */ r) => r.status === "failed",
  );
  if (diffResult === undefined) fail("diff suite reported no failed test");
  const diffArtifacts = diffResult.artifacts.filter(
    (/** @type {{ kind: string }} */ a) => a.kind === "diff",
  );
  if (diffArtifacts.length < 3) {
    fail(`failed comparison left ${diffArtifacts.length} diff artifacts, expected at least 3`);
  }
  for (const artifact of diffArtifacts) {
    if (!existsSync(artifact.path)) fail(`diff artifact ${artifact.path} is in the report but not on disk`);
  }
  const diffJson = diffArtifacts.find((/** @type {{ name: string }} */ a) =>
    a.name.endsWith(".diff.json"),
  );
  if (diffJson === undefined) fail("no .diff.json among the diff artifacts");
  const diagnostic = JSON.parse(readFileSync(diffJson.path, "utf-8"));
  if (diagnostic.schema !== "ae-test.image-diff/v1") {
    fail(`diff diagnostic schema is ${JSON.stringify(diagnostic.schema)}, expected ae-test.image-diff/v1`);
  }
  if (diagnostic.difference?.differentPixels <= 0 || diagnostic.options?.threshold !== 0) {
    fail(`unexpected diff diagnostic: ${JSON.stringify(diagnostic)}`);
  }
  if (!diffResult.failure?.message?.includes("diff evidence")) {
    fail(`failure message does not reference the diff evidence: ${diffResult.failure?.message}`);
  }

  // Bare `ae-test` in the consumer project: config + discovery, no flags.
  // The suite snapshots, so record baselines through the same config first —
  // exactly the flow a consumer follows once.
  const record = cli(["--update-snapshots"]);
  if (record.status !== 0) {
    fail(`config/discovery update run exited ${record.status}\n${record.stdout}\n${record.stderr}`);
  }
  const discovered = cli([]);
  if (discovered.status !== 0) {
    fail(`config/discovery run exited ${discovered.status}\n${discovered.stdout}\n${discovered.stderr}`);
  }
  const discoveredReport = JSON.parse(
    readFileSync(join(project, "results-config", "report.json"), "utf-8"),
  );
  if (discoveredReport.results.length !== 2 ||
      discoveredReport.results.some((/** @type {{ status: string }} */ r) => r.status !== "passed")) {
    fail(`discovered suite reported ${JSON.stringify(discoveredReport.results.map((/** @type {{status:string}} */ r) => r.status))}`);
  }

  // With no config and no specs in an empty directory, discovery is a setup
  // error (2), not a green zero-test run.
  const empty = join(project, "empty");
  mkdirSync(empty, { recursive: true });
  const none = cliIn(empty, []);
  if (none.status !== 2) fail(`no test files exited ${none.status}, expected 2`);

  // The committed consumer example under examples/ must work verbatim: it is
  // what a new user copies, so it is exercised here against the tarball —
  // install, config discovery, snapshot record, then a clean rerun.
  const exampleSrc = join(ROOT, "examples", "consumer");
  const example = join(workdir, "example-consumer");
  mkdirSync(example, { recursive: true });
  for (const entry of readdirSync(exampleSrc, { withFileTypes: true })) {
    const src = join(exampleSrc, entry.name);
    if (entry.isDirectory()) {
      execFileSync("cp", ["-R", src, join(example, entry.name)]);
    } else {
      copyFileSync(src, join(example, entry.name));
    }
  }
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: example, stdio: "inherit" });
  const exampleBin = join(example, "node_modules", ".bin", "ae-test");
  const exampleRecord = spawnSync(exampleBin, ["--update-snapshots"], { cwd: example, encoding: "utf-8" });
  if (exampleRecord.status !== 0) {
    fail(`consumer example baseline run exited ${exampleRecord.status}\n${exampleRecord.stdout}\n${exampleRecord.stderr}`);
  }
  const exampleRun = spawnSync(exampleBin, [], { cwd: example, encoding: "utf-8" });
  if (exampleRun.status !== 0) {
    fail(`consumer example run exited ${exampleRun.status}\n${exampleRun.stdout}\n${exampleRun.stderr}`);
  }
  const exampleReport = JSON.parse(
    readFileSync(join(example, ".ae-test-results", "report.json"), "utf-8"),
  );
  if (exampleReport.results.length !== 1 ||
      exampleReport.results[0].status !== "passed") {
    fail(`consumer example reported ${JSON.stringify(exampleReport.results.map((/** @type {{status:string}} */ r) => r.status))}`);
  }

  console.log(
    `consumer install ok: ae-a8n ${a8n.version} from the registry; ` +
      `passing suite 0 (${readdirSync(join(project, "results")).length} entries in results/), failing suite 1, no files 2; ` +
      `examples/consumer green`,
  );
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
