/**
 * Image diff artifacts (Issue #35).
 *
 * When a pixel comparison fails, the runner leaves evidence a reviewer can
 * open: copies of both images, a diff PNG marking the diverging pixels, and
 * a JSON diagnostic with the numbers. These tests pin that contract at both
 * levels — the artifact writer itself, and the runner wiring that turns a
 * failed `toMatchSnapshot` / `toMatchFrame` into `diff` artifacts.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodePng, FakeAfterEffectsTransport } from "@ido-bata/ae-a8n/testing";
import { PNG } from "pngjs";

import { clearRegistry, run } from "../dist/index.js";
import { ImageComparisonError, writeImageDiffArtifacts } from "../dist/image.js";
import type { ImageDifference, RunOptions } from "../dist/index.js";

let dir: string;
let specsDir: string;
let projectDir: string;
let baselineDir: string;

beforeEach(() => {
  clearRegistry();
  dir = mkdtempSync(join(tmpdir(), "ae-test-diff-"));
  specsDir = join(dir, "specs");
  projectDir = join(dir, "projects");
  baselineDir = join(dir, "baselines");
  mkdirSync(specsDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "fixture.aep"), "placeholder");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePng(name: string, changedPixel?: readonly [number, number, number]): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    encodePng(2, 2, (x, y) => {
      if (changedPixel !== undefined && x === 1 && y === 1) {
        return changedPixel;
      }
      return [10, 20, 30];
    }),
  );
  return path;
}

describe("writeImageDiffArtifacts", () => {
  it("writes image copies, a diff PNG and a JSON diagnostic", () => {
    const expected = writePng("expected.png");
    const actual = writePng("actual.png", [200, 0, 0]);
    const difference: ImageDifference = {
      expectedPath: expected,
      actualPath: actual,
      width: 2,
      height: 2,
      totalPixels: 4,
      differentPixels: 1,
      differentPixelRatio: 0.25,
      maxChannelDelta: 190,
      firstDifference: {
        x: 1,
        y: 1,
        expected: [10, 20, 30, 255],
        actual: [200, 0, 0, 255],
      },
      passed: false,
    };

    const written = writeImageDiffArtifacts({
      dir: join(dir, "diffs"),
      baseName: "test--frame",
      expectedPath: expected,
      actualPath: actual,
      outcome: difference,
      options: { threshold: 0 },
    });

    for (const path of [
      written.expectedPath,
      written.actualPath,
      written.diffPath,
      written.reportPath,
    ]) {
      expect(path).toBeDefined();
      expect(existsSync(path!)).toBe(true);
    }

    const report = JSON.parse(readFileSync(written.reportPath, "utf-8")) as Record<string, unknown>;
    expect(report.schema).toBe("ae-test.image-diff/v1");
    const diff = report.difference as Record<string, unknown>;
    expect(diff.differentPixels).toBe(1);
    expect(diff.differentPixelRatio).toBe(0.25);
    expect(diff.maxChannelDelta).toBe(190);
    const options = report.options as Record<string, unknown>;
    expect(options.threshold).toBe(0);
    expect(report.error).toBeNull();

    // The diff PNG marks the diverging pixel: at (1,1) it must be magenta.
    const diffPng = PNG.sync.read(readFileSync(written.diffPath!));
    const offset = (1 * 2 + 1) * 4;
    expect([...diffPng.data.slice(offset, offset + 3)]).toEqual([255, 0, 255]);
    // An untouched pixel keeps the actual colour.
    const same = (0 * 2 + 0) * 4;
    expect([...diffPng.data.slice(same, same + 3)]).toEqual([10, 20, 30]);
  });

  it("records the error and skips the diff PNG when sizes differ", () => {
    const expected = writePng("expected.png");
    // Point `actualPath` at a differently-sized PNG.
    const other = join(dir, "other.png");
    writeFileSync(other, encodePng(4, 4, () => [0, 0, 0]));

    const written = writeImageDiffArtifacts({
      dir: join(dir, "diffs"),
      baseName: "test--frame",
      expectedPath: expected,
      actualPath: other,
      outcome: new ImageComparisonError("cannot compare renders with different dimensions", {
        expected: { width: 2, height: 2 },
        actual: { width: 4, height: 4 },
      }),
    });

    expect(written.diffPath).toBeUndefined();
    expect(existsSync(written.expectedPath)).toBe(true);
    expect(existsSync(written.actualPath)).toBe(true);
    const report = JSON.parse(readFileSync(written.reportPath, "utf-8")) as Record<string, unknown>;
    expect(report.difference).toBeNull();
    expect(report.error).toContain("different dimensions");
    expect(report.diff).toBeNull();
    // The dimensions survive as structured fields, not only inside the message.
    const sizes = report.sizes as Record<string, unknown>;
    expect(sizes.expected).toEqual({ width: 2, height: 2 });
    expect(sizes.actual).toEqual({ width: 4, height: 4 });
  });

  it("honours the threshold when marking diff pixels", () => {
    const expected = writePng("expected.png");
    // Delta is 190 on one channel — inside a threshold of 200.
    const actual = writePng("actual.png", [200, 20, 30]);
    const difference: ImageDifference = {
      expectedPath: expected,
      actualPath: actual,
      width: 2,
      height: 2,
      totalPixels: 4,
      differentPixels: 0,
      differentPixelRatio: 0,
      maxChannelDelta: 190,
      firstDifference: undefined,
      passed: false,
    };

    const written = writeImageDiffArtifacts({
      dir: join(dir, "diffs"),
      baseName: "test--frame",
      expectedPath: expected,
      actualPath: actual,
      outcome: difference,
      options: { threshold: 200 },
    });

    const diffPng = PNG.sync.read(readFileSync(written.diffPath!));
    // No pixel exceeds the threshold, so nothing is painted magenta: the diff
    // image is the actual render unchanged.
    const offset = (1 * 2 + 1) * 4;
    expect([...diffPng.data.slice(offset, offset + 3)]).toEqual([200, 20, 30]);
    const report = JSON.parse(readFileSync(written.reportPath, "utf-8")) as Record<string, unknown>;
    expect((report.options as Record<string, unknown>).threshold).toBe(200);
  });
});

const DIFF_SPEC = `
const EFFECT = "ADBE Fake Gaussian Blur";
test("two renders diverge", async ({ ae, fixture, expectFrame }) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const comp = await project.comp("Main");
  const layer = await comp.layer("Solid 1");
  const effect = await layer.effects.apply(EFFECT);
  await effect.parameter("Amount").set(10);
  const low = await comp.renderFrame(0, { subdirectory: "low" });
  await expectFrame(low).toMatchSnapshot("low", { threshold: 0 });
  await effect.parameter("Amount").set(90);
  const high = await comp.renderFrame(0, { subdirectory: "high" });
  await expectFrame(high).toMatchSnapshot("high", { threshold: 0 });
});
`;

const FRAME_DIFF_SPEC = `
const EFFECT = "ADBE Fake Gaussian Blur";
test("frames compared directly", async ({ ae, fixture, expectFrame }) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const comp = await project.comp("Main");
  const layer = await comp.layer("Solid 1");
  const effect = await layer.effects.apply(EFFECT);
  await effect.parameter("Amount").set(10);
  const low = await comp.renderFrame(0, { subdirectory: "low" });
  await effect.parameter("Amount").set(90);
  const high = await comp.renderFrame(0, { subdirectory: "high" });
  await expectFrame(high).toMatchFrame(low, { threshold: 0 });
});
`;

const PASSING_FRAME_SPEC = `
const EFFECT = "ADBE Fake Gaussian Blur";
test("identical frames pass", async ({ ae, fixture, expectFrame }) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const comp = await project.comp("Main");
  const layer = await comp.layer("Solid 1");
  await layer.effects.apply(EFFECT);
  const first = await comp.renderFrame(0, { subdirectory: "first" });
  const second = await comp.renderFrame(0, { subdirectory: "second" });
  await expectFrame(second).toMatchFrame(first, { threshold: 0 });
});
`;

const MISSING_SPEC = `
test("snapshot without a baseline", async ({ ae, fixture, expectFrame }) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const comp = await project.comp("Main");
  const frame = await comp.renderFrame(0);
  await expectFrame(frame).toMatchSnapshot("never-recorded", { threshold: 0 });
});
`;

function writeSpec(name: string, body: string): string {
  const path = join(specsDir, name);
  writeFileSync(
    path,
    `import { test, expectFrame } from "${resolve(import.meta.dirname, "..", "dist", "index.js")}";\n${body}`,
    "utf-8",
  );
  return path;
}

function options(file: string, resultsName: string, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    files: [file],
    resultsDir: join(dir, resultsName),
    baselineDir,
    projectsDir: projectDir,
    transport: new FakeAfterEffectsTransport(),
    timeoutMs: 20_000,
    ...overrides,
  };
}

/** Files under the fake-host baseline namespace matching `suffix`. */
function baselineFiles(suffix: string): string[] {
  const envDir = join(baselineDir, "fake-in-process");
  if (!existsSync(envDir)) return [];
  return readdirSync(envDir).filter((name) => name.endsWith(suffix));
}

/** Copies the "low" baseline (digest + PNG) over the "high" one. */
function corruptHighBaseline(): void {
  const envDir = join(baselineDir, "fake-in-process");
  const from = readdirSync(envDir).find((file) => file.endsWith("--low.png"));
  const to = readdirSync(envDir).find((file) => file.endsWith("--high.png"));
  if (from === undefined || to === undefined) {
    throw new Error(`baseline files not found: ${from} / ${to}`);
  }
  copyFileSync(join(envDir, from), join(envDir, to));
  copyFileSync(
    join(envDir, from.replace(/\.png$/, ".sha256")),
    join(envDir, to.replace(/\.png$/, ".sha256")),
  );
}

describe("image diff artifacts", () => {
  it("leaves diff evidence when a snapshot comparison fails", async () => {
    const spec = writeSpec("diff.spec.ts", DIFF_SPEC);
    const recorded = await run(options(spec, "results-1", { updateSnapshots: true }));
    expect(recorded.results[0]?.status).toBe("passed");
    clearRegistry();

    // Corrupt the "high" baseline with the "low" render: the digest no longer
    // matches, so the pixel comparison runs and fails.
    corruptHighBaseline();

    const summary = await run(options(spec, "results-2"));
    const result = summary.results[0];
    expect(result?.status).toBe("failed");

    const diffs = result?.artifacts.filter((artifact) => artifact.kind === "diff") ?? [];
    expect(diffs.length).toBeGreaterThanOrEqual(3);
    for (const artifact of diffs) {
      expect(existsSync(artifact.path)).toBe(true);
      expect(artifact.name.startsWith("diffs/")).toBe(true);
    }

    const reportPath = diffs.find((artifact) => artifact.name.endsWith(".diff.json"))?.path;
    expect(reportPath).toBeDefined();
    const report = JSON.parse(readFileSync(reportPath!, "utf-8")) as Record<string, unknown>;
    const difference = report.difference as Record<string, unknown>;
    expect(difference.differentPixels as number).toBeGreaterThan(0);
    expect((report.options as Record<string, unknown>).threshold).toBe(0);

    const message = result?.failure?.message ?? "";
    expect(message).toContain("diff evidence");
    expect(message).toContain("diff.json");
  });

  it("leaves diff evidence when a direct frame comparison fails", async () => {
    const spec = writeSpec("frame-diff.spec.ts", FRAME_DIFF_SPEC);
    const summary = await run(options(spec, "results-1"));
    const result = summary.results[0];
    expect(result?.status).toBe("failed");

    const diffs = result?.artifacts.filter((artifact) => artifact.kind === "diff") ?? [];
    expect(diffs.some((artifact) => artifact.name.includes("frame-1"))).toBe(true);
    const reportPath = diffs.find((artifact) => artifact.name.endsWith(".diff.json"))?.path;
    expect(reportPath).toBeDefined();
    const report = JSON.parse(readFileSync(reportPath!, "utf-8")) as Record<string, unknown>;
    expect((report.difference as Record<string, unknown>).differentPixels as number).toBeGreaterThan(0);
  });

  it("writes no diff artifacts when the comparison passes", async () => {
    const spec = writeSpec("passing-frame.spec.ts", PASSING_FRAME_SPEC);
    const summary = await run(options(spec, "results-1"));
    const result = summary.results[0];
    expect(result?.status).toBe("passed");
    expect(result?.artifacts.filter((artifact) => artifact.kind === "diff")).toHaveLength(0);
    expect(baselineFiles(".diff.json")).toHaveLength(0);
    const resultsDir = join(dir, "results-1");
    const leftovers = existsSync(resultsDir)
      ? readdirSync(resultsDir, { recursive: true }).filter((name) =>
          String(name).includes(".diff."),
        )
      : [];
    expect(leftovers).toHaveLength(0);
  });

  it("writes no diff artifacts when the baseline is missing", async () => {
    const spec = writeSpec("missing.spec.ts", MISSING_SPEC);
    const summary = await run(options(spec, "results-1"));
    const result = summary.results[0];
    expect(result?.status).toBe("failed");
    expect(result?.failure?.message).toContain("no snapshot baseline");
    expect(result?.artifacts.filter((artifact) => artifact.kind === "diff")).toHaveLength(0);
    expect(baselineFiles(".diff.json")).toHaveLength(0);
  });
});
