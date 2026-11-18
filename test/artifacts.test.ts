/**
 * Artifact collection must never throw: it runs in the runner's `finally`
 * before teardown, so a failure there would skip `boundedTeardown` and
 * leave an owned After Effects running. A render file that vanishes
 * between directory listing and `stat` is skipped, not fatal.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeAfterEffectsTransport } from "@ido-bata/ae-a8n/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TestFixture } from "../src/fixture.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ae-test-artifacts-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("collectArtifacts resilience", () => {
  it("skips a render that vanishes between listing and stat", async () => {
    const transport = new FakeAfterEffectsTransport();
    const fixture = new TestFixture(
      { id: "t", title: "t", file: "test/artifacts.test.ts", outputDir: dir },
      { resultsDir: dir, transport },
    );
    const ae = await fixture.session();

    // A dangling symlink stats as ENOENT — the same failure as a file
    // deleted mid-scan.
    mkdirSync(ae.artifactsDir, { recursive: true });
    symlinkSync(join(dir, "does-not-exist.png"), join(ae.artifactsDir, "ghost.png"));
    writeFileSync(join(ae.artifactsDir, "real.png"), Buffer.from("png"));

    const artifacts = fixture.collectArtifacts(ae);
    expect(artifacts.some((a) => a.name.endsWith("real.png"))).toBe(true);
    expect(artifacts.some((a) => a.name.endsWith("ghost.png"))).toBe(false);
  });
});
