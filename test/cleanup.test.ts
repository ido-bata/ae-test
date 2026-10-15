/**
 * A run's result covers the whole test, teardown included, and never runs a
 * test against an After Effects nobody can vouch for.
 *
 * On a real host (AE 26.5x89, 2026-10-15) a session's app.quit timed out,
 * teardown swallowed the error, the test was reported as passed, and the next
 * test launched into the stuck AE and failed after 180 s for a reason that was
 * not its own.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HostOwnership } from "@ido-bata/ae-a8n";
import { FakeAfterEffectsTransport } from "@ido-bata/ae-a8n/testing";

import { exitCodeFor, formatRun, run } from "../dist/index.js";

let resultsDir: string;
let specsDir: string;
let projectDir: string;

beforeEach(() => {
  resultsDir = mkdtempSync(join(tmpdir(), "ae-test-cleanup-"));
  specsDir = mkdtempSync(join(tmpdir(), "ae-test-specs-"));
  projectDir = mkdtempSync(join(tmpdir(), "ae-test-projects-"));
  writeFileSync(join(projectDir, "fixture.aep"), "placeholder");
  (globalThis as { __bodies?: string[] }).__bodies = [];
});

afterEach(() => {
  for (const dir of [resultsDir, specsDir, projectDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Three tests; each records that its body ran. The second can be made to throw. */
function spec(secondThrows = false): string {
  const path = join(specsDir, "three.spec.ts");
  const body = (name: string, fails = false) => `
test(${JSON.stringify(name)}, async ({ ae }) => {
  globalThis.__bodies.push(${JSON.stringify(name)});
  await ae.version();
  ${fails ? 'throw new Error("body failed");' : ""}
});`;
  writeFileSync(
    path,
    `import { test } from "${resolve(import.meta.dirname, "..", "dist", "index.js")}";\n` +
      body("first") +
      body("second", secondThrows) +
      body("third"),
    "utf-8",
  );
  return path;
}

const bodies = () => (globalThis as { __bodies?: string[] }).__bodies ?? [];

/** Quits fine until `failOnClose` is set, then AE "does not exit". */
class QuitFailsTransport extends FakeAfterEffectsTransport {
  failOnClose = false;
  override close(): Promise<void> {
    if (this.failOnClose) {
      return Promise.reject(new Error("After Effects did not exit within 60000 ms of app.quit"));
    }
    return super.close();
  }
}

/** Owned at launch; no longer identifiable once a test body has run. */
class OwnershipLostTransport extends FakeAfterEffectsTransport {
  override ownership(): HostOwnership {
    return bodies().length === 0
      ? { kind: "owned", evidence: "fake" }
      : { kind: "unknown", evidence: "pid 42 this session started is gone" };
  }
}

describe("a teardown that fails", () => {
  it("fails a test whose body passed, and blocks the tests after it", async () => {
    const transport = new QuitFailsTransport();
    transport.failOnClose = true;
    const summary = await run({ files: [spec()], resultsDir, projectsDir: projectDir, transport });

    const [first, second, third] = summary.results;
    expect(first).toMatchObject({
      status: "failed",
      cleanup: { status: "failed" },
      failure: { name: "CleanupError", phase: "cleanup" },
    });
    expect(first?.failure?.message).toMatch(/test body passed, but teardown failed.*did not exit/);
    for (const later of [second, third]) {
      expect(later).toMatchObject({ status: "blocked" });
      expect(later?.blockedReason).toMatch(/"first" did not clean up/);
    }
    // Not run at all — not run and failed.
    expect(bodies()).toEqual(["first"]);
    expect(exitCodeFor(summary)).toBe(1);
    expect(formatRun(summary)).toMatch(/0 passed, 1 failed, 0 timed out, 0 skipped, 2 blocked/);
  });

  it("keeps the body's failure as the reason, and records the teardown failure too", async () => {
    const transport = new QuitFailsTransport();
    const summary = await run({
      files: [spec(true)],
      resultsDir,
      projectsDir: projectDir,
      transport,
      onResult: (result) => {
        // The first test closes cleanly; the second's teardown will fail.
        if (result.title === "first") transport.failOnClose = true;
      },
    });

    const second = summary.results[1];
    expect(second).toMatchObject({
      status: "failed",
      failure: { message: "body failed", phase: "body" },
      cleanup: { status: "failed" },
    });
    expect(formatRun(summary)).toMatch(/teardown also failed: .*After Effects did not exit/);
    expect(summary.results[2]).toMatchObject({ status: "blocked" });
  });

  it("counts an AE left running as a failed teardown", async () => {
    const summary = await run({
      files: [spec()],
      resultsDir,
      projectsDir: projectDir,
      transport: new OwnershipLostTransport(),
    });
    expect(summary.results[0]).toMatchObject({
      status: "failed",
      cleanup: { status: "failed", name: "HostLeftRunning" },
    });
    expect(summary.results[1]).toMatchObject({ status: "blocked" });
  });
});

describe("a session that cannot start", () => {
  it("blocks the rest instead of launching into an unknown host", async () => {
    const transport = new FakeAfterEffectsTransport();
    transport.invoke = () => Promise.reject(new Error("osascript exited with code 1: -609"));
    const summary = await run({ files: [spec()], resultsDir, projectsDir: projectDir, transport, timeoutMs: 2_000 });

    expect(summary.results[0]).toMatchObject({ status: "failed", failure: { phase: "launch" } });
    expect(summary.results.slice(1).map((result) => result.status)).toEqual(["blocked", "blocked"]);
    expect(bodies()).toEqual([]);
  });
});

describe("an After Effects this run did not start", () => {
  it.each(["attached", "unknown"] as const)("is left alone (%s), and nothing runs against it", async (kind) => {
    const transport = new FakeAfterEffectsTransport();
    transport.ownershipKind = kind;
    const summary = await run({ files: [spec()], resultsDir, projectsDir: projectDir, transport });

    expect(summary.results[0]).toMatchObject({
      status: "failed",
      failure: { name: "HostNotOwnedError", phase: "launch" },
    });
    expect(summary.results.slice(1).map((result) => result.status)).toEqual(["blocked", "blocked"]);
    expect(bodies()).toEqual([]);
    expect(transport.app.quitCount).toBe(0);
  });
});

describe("a clean run", () => {
  it("records a successful teardown for every test", async () => {
    const summary = await run({
      files: [spec()],
      resultsDir,
      projectsDir: projectDir,
      transport: new FakeAfterEffectsTransport(),
    });
    expect(summary.results.map((result) => [result.status, result.cleanup])).toEqual([
      ["passed", { status: "ok", quit: true }],
      ["passed", { status: "ok", quit: true }],
      ["passed", { status: "ok", quit: true }],
    ]);
    expect(exitCodeFor(summary)).toBe(0);
  });
});
