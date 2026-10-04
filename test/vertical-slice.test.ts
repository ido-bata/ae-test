/**
 * The vertical slice, driven through the real runner.
 *
 * `specs/plugin-render.spec.ts` is ordinary test code. This file is what proves
 * the harness runs it unattended: launch, operate, render, assert, collect
 * artifacts, tear down — no human input anywhere in the loop.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeAfterEffectsTransport } from "@ido-bata/ae-a8n/testing";

// The built entry point, because the specs import it too: two module instances
// of the registry would mean a run sees none of the specs' declarations.
import { clearRegistry, exitCodeFor, formatRun, run } from "../dist/index.js";

const SPEC = resolve(import.meta.dirname, "..", "specs", "plugin-render.spec.ts");
const PROJECTS_DIR = resolve(import.meta.dirname, "..", "fixtures");

let resultsDir: string;

beforeEach(() => {
  clearRegistry();
  resultsDir = mkdtempSync(join(tmpdir(), "ae-test-results-"));
});

afterEach(() => {
  rmSync(resultsDir, { recursive: true, force: true });
});

function suiteOptions(overrides: Partial<Parameters<typeof run>[0]> = {}) {
  return {
    files: [SPEC],
    resultsDir,
    projectsDir: PROJECTS_DIR,
    transport: new FakeAfterEffectsTransport(),
    timeoutMs: 20_000,
    ...overrides,
  };
}

describe("vertical slice", () => {
  it("runs the whole path unattended and passes", async () => {
    const summary = await run(suiteOptions({ updateSnapshots: true }));

    expect(summary.results.map((result) => result.title)).toEqual([
      "applies a plugin effect and renders a frame",
      "reads a parameter back after setting it",
      "the parameter reaches the pixels",
      "reports a missing composition as a typed failure",
    ]);
    for (const result of summary.results) {
      expect(result.status, `${result.title}: ${result.failure?.message ?? ""}`).toBe("passed");
    }
    expect(exitCodeFor(summary)).toBe(0);
  });

  it("produces a machine-readable report", async () => {
    const summary = await run(suiteOptions({ updateSnapshots: true }));
    const report = JSON.parse(readFileSync(summary.reportPath, "utf-8")) as {
      results: Array<{ status: string; artifacts: unknown[] }>;
    };
    expect(report.results).toHaveLength(4);
    expect(report.results.every((result) => result.artifacts.length > 0)).toBe(true);
  });

  it("collects a render artifact and a trace for every test", async () => {
    const summary = await run(suiteOptions({ updateSnapshots: true }));

    const renderTest = summary.results[0];
    expect(renderTest?.artifacts.some((artifact) => artifact.kind === "render")).toBe(true);
    expect(renderTest?.artifacts.some((artifact) => artifact.kind === "trace")).toBe(true);

    for (const artifact of renderTest?.artifacts ?? []) {
      expect(existsSync(artifact.path), `${artifact.name} should exist`).toBe(true);
    }
  });

  it("records the operations the run actually performed", async () => {
    const summary = await run(suiteOptions({ updateSnapshots: true }));
    const traceArtifact = summary.results[0]?.artifacts.find(
      (artifact) => artifact.kind === "trace",
    );
    expect(traceArtifact).toBeDefined();

    const events = readFileSync(traceArtifact?.path ?? "", "utf-8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { op: string; status: string });

    expect(events.map((event) => event.op)).toEqual(
      expect.arrayContaining([
        "session.launch",
        "project.open",
        "comp.info",
        "layer.applyEffect",
        "comp.renderFrame",
        "session.close",
      ]),
    );
    expect(events.every((event) => event.status === "ok")).toBe(true);
  });

  it("compares against recorded snapshot baselines on a second run", async () => {
    await run(suiteOptions({ updateSnapshots: true }));
    clearRegistry();

    // Same specs, same fake, no update flag: the baseline path must be
    // exercised, not just the write path.
    const second = await run(suiteOptions());
    expect(second.results.every((result) => result.status === "passed")).toBe(true);
  });

  it("fails when a render no longer matches its baseline", async () => {
    await run(suiteOptions({ updateSnapshots: true }));
    clearRegistry();

    // Re-point the snapshot at a digest that cannot match, which is what a
    // plugin regression looks like from the harness's side.
    const snapshotDir = join(resultsDir, "__snapshots__");
    const { readdirSync, writeFileSync } = await import("node:fs");
    const baseline = readdirSync(snapshotDir).find((name) => name.includes("main-frame-0"));
    expect(baseline).toBeDefined();
    writeFileSync(join(snapshotDir, baseline as string), `${"0".repeat(64)}\n`, "utf-8");
    clearRegistry();

    const third = await run(suiteOptions());
    const failed = third.results[0];
    expect(failed?.status).toBe("failed");
    expect(failed?.failure?.message).toMatch(/does not match its baseline/);
    // The render is still on disk, so the mismatch is inspectable.
    expect(
      failed?.artifacts.some((artifact) => artifact.kind === "render"),
    ).toBe(true);
    expect(exitCodeFor(third)).toBe(1);
  });

  it("formats a run into something a human can act on", async () => {
    const summary = await run(suiteOptions({ updateSnapshots: true }));
    const text = formatRun(summary);
    expect(text).toContain("applies a plugin effect and renders a frame");
    expect(text).toContain("4 passed");
    expect(text).toContain("report:");
  });

  it("leaves no After Effects session behind", async () => {
    const transport = new FakeAfterEffectsTransport();
    await run(suiteOptions({ transport }));
    // Four tests ran; each must have torn its own session down.
    expect(transport.closed).toBe(true);
  });

  it("honours a title filter", async () => {
    const summary = await run(suiteOptions({ updateSnapshots: true, grep: "parameter reads" }));
    expect(summary.results).toHaveLength(0);

    const matched = await run(suiteOptions({ updateSnapshots: true, grep: "reads a parameter" }));
    expect(matched.results).toHaveLength(1);
  });
});
