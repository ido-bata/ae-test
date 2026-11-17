/**
 * Runner lifecycle safety: what happens after a test outlives its budget,
 * when teardown cannot answer, when the run is interrupted, and when a spec
 * file cannot even be imported.
 *
 * These are fault-injection cases against ae-a8n's fake transport — the
 * invariants they pin (bounded waits, no re-sent operations, evidence on
 * disk) are exactly the ones a real After Effects hang would exercise.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeAfterEffectsTransport } from "@ido-bata/ae-a8n/testing";

import {
  exitCodeFor,
  formatRun,
  run,
} from "../dist/index.js";
import type { RunOptions, RunSummary } from "../dist/index.js";

type ReportSnapshot = Pick<RunSummary, "results" | "partial">;

function readReport(): ReportSnapshot {
  return JSON.parse(readFileSync(join(resultsDir, "report.json"), "utf-8")) as ReportSnapshot;
}

let resultsDir: string;
let specsDir: string;
let projectDir: string;

beforeEach(() => {
  resultsDir = mkdtempSync(join(tmpdir(), "ae-test-lifecycle-"));
  specsDir = mkdtempSync(join(tmpdir(), "ae-test-specs-"));
  projectDir = mkdtempSync(join(tmpdir(), "ae-test-projects-"));
  writeFileSync(join(projectDir, "fixture.aep"), "placeholder");
  delete (globalThis as { __gate?: Promise<void> }).__gate;
});

afterEach(() => {
  for (const dir of [resultsDir, specsDir, projectDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeSpec(name: string, body: string): string {
  const path = join(specsDir, name);
  writeFileSync(
    path,
    `import { test, expect } from "${resolve(import.meta.dirname, "..", "dist", "index.js")}";\n${body}`,
    "utf-8",
  );
  return path;
}

function options(file: string | readonly string[], overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    files: typeof file === "string" ? [file] : file,
    resultsDir,
    projectsDir: projectDir,
    transport: new FakeAfterEffectsTransport(),
    timeoutMs: 5_000,
    ...overrides,
  };
}

/** session.close() never answers — the teardown-hang fault. */
class HungCloseTransport extends FakeAfterEffectsTransport {
  override close(): Promise<void> {
    return new Promise<void>(() => {});
  }
}

/** session launch answers only after `delayMs`. */
class SlowLaunchTransport extends FakeAfterEffectsTransport {
  constructor(private readonly delayMs: number) {
    super();
  }
  override async launch(): Promise<void> {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, this.delayMs));
    await super.launch();
  }
}

describe("a teardown that never answers", () => {
  it("is bounded, reported, and blocks the rest instead of stalling the run", async () => {
    const file = writeSpec(
      "three.spec.ts",
      `
test("first", async ({ ae }) => { await ae.version(); });
test("second", async ({ ae }) => { await ae.version(); });
test("third", async ({ ae }) => { await ae.version(); });
`,
    );

    const began = Date.now();
    const summary = await run(
      options(file, {
        transport: new HungCloseTransport(),
        teardownTimeoutMs: 120,
      }),
    );

    // The run finished in bounded time — it did not wait on the hung close.
    expect(Date.now() - began).toBeLessThan(10_000);
    const [first, second, third] = summary.results;
    expect(first).toMatchObject({
      status: "failed",
      cleanup: { status: "failed", name: "TeardownTimeoutError" },
      failure: { name: "CleanupError", phase: "cleanup" },
    });
    expect(first?.cleanup?.status === "failed" && first.cleanup.message).toMatch(
      /did not complete within 120ms/,
    );
    for (const later of [second, third]) {
      expect(later).toMatchObject({ status: "blocked" });
      expect(later?.blockedReason).toMatch(/"first" did not clean up/);
    }
    expect(exitCodeFor(summary)).toBe(1);
    // The report exists and names the timeout — evidence survived.
    const cleanup = readReport().results[0]?.cleanup;
    expect(cleanup?.status === "failed" ? cleanup.name : undefined).toBe("TeardownTimeoutError");
  });
});

describe("a body that outlives its budget", () => {
  it("records bodyStillRunning when the body never settles", async () => {
    const file = writeSpec(
      "slow.spec.ts",
      `
test("never finishes", async () => { await globalThis.__gate; });
`,
    );
    // The gate resolves only after the run is over, so the body is still
    // pending when the drain budget expires.
    let release!: () => void;
    (globalThis as { __gate?: Promise<void> }).__gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });

    const summary = await run(
      options(file, { drainTimeoutMs: 120, timeoutMs: 100 }),
    );

    expect(summary.results[0]).toMatchObject({
      status: "timed-out",
      failure: { name: "TestTimeoutError", bodyStillRunning: true },
    });
    // Teardown still ran and the session was closed.
    expect(summary.results[0]?.cleanup).toEqual({ status: "ok", quit: true });
    release();
  });

  it("does not flag a body that settles inside the drain window", async () => {
    const file = writeSpec(
      "drains.spec.ts",
      `
test("finishes just late", async () => {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
});
`,
    );

    const summary = await run(
      options(file, { drainTimeoutMs: 2_000, timeoutMs: 50 }),
    );

    expect(summary.results[0]?.status).toBe("timed-out");
    expect(summary.results[0]?.failure?.bodyStillRunning).toBeUndefined();
  });
});

describe("an interrupted run", () => {
  it("interrupts the in-flight test, blocks the rest, and still writes the report", async () => {
    const file = writeSpec(
      "three.spec.ts",
      `
test("first", async ({ ae }) => { await ae.version(); await globalThis.__gate; });
test("second", async ({ ae }) => { await ae.version(); });
test("third", async ({ ae }) => { await ae.version(); });
`,
    );
    let release!: () => void;
    (globalThis as { __gate?: Promise<void> }).__gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });

    const controller = new AbortController();
    const pending = run(
      options(file, {
        signal: controller.signal,
        drainTimeoutMs: 120,
        timeoutMs: 30_000,
      }),
    );
    // Let the first test reach its body, then interrupt.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    controller.abort();
    const summary = await pending;

    const [first, second, third] = summary.results;
    expect(first).toMatchObject({
      status: "interrupted",
      failure: { name: "RunInterruptedError", phase: "body" },
    });
    expect(first?.cleanup).toEqual({ status: "ok", quit: true });
    for (const later of [second, third]) {
      expect(later).toMatchObject({ status: "blocked" });
      expect(later?.blockedReason).toMatch(/interrupted/);
    }
    expect(exitCodeFor(summary)).toBe(1);
    expect(formatRun(summary)).toMatch(/1 interrupted/);
    const report = readReport();
    expect(report.partial).toBeUndefined();
    expect(report.results.map((r) => r.status)).toEqual([
      "interrupted",
      "blocked",
      "blocked",
    ]);
    release();
  });

  it("interrupts a launch in flight without orphaning the session", async () => {
    const file = writeSpec(
      "launch.spec.ts",
      `
test("waits for a session", async ({ ae }) => { await ae.version(); });
`,
    );
    const transport = new SlowLaunchTransport(400);
    const controller = new AbortController();
    const pending = run(
      options(file, { transport, signal: controller.signal, timeoutMs: 30_000 }),
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    controller.abort();
    const summary = await pending;

    expect(summary.results[0]).toMatchObject({
      status: "interrupted",
      failure: { name: "RunInterruptedError" },
    });
    // The launch that was already in flight completed and was torn down —
    // no After Effects is left running for nobody.
    expect(summary.results[0]?.cleanup).toEqual({ status: "ok", quit: true });
    expect(transport.closed).toBe(true);
  });
});

describe("a spec that fails to load", () => {
  it("is reported as its own failure while the rest of the suite still runs", async () => {
    const bad = writeSpec(
      "broken.spec.ts",
      `throw new Error("syntax is not the problem; this file just cannot load");\n`,
    );
    const good = writeSpec(
      "good.spec.ts",
      `test("still runs", async ({ ae }) => { await ae.version(); });\n`,
    );

    const summary = await run(options([bad, good]));

    expect(summary.results).toHaveLength(2);
    expect(summary.results[0]).toMatchObject({
      status: "failed",
      failure: { phase: "load" },
    });
    expect(summary.results[0]?.failure?.message).toMatch(/cannot load/);
    expect(summary.results[1]).toMatchObject({ status: "passed" });
    expect(exitCodeFor(summary)).toBe(1);
  });
});

describe("a body that outlives its context", () => {
  it("has every handle revoked, writes nothing, and lets the next test run", async () => {
    const file = writeSpec(
      "zombie.spec.ts",
      `
import { existsSync } from "node:fs";
import { join } from "node:path";

test("times out with work left behind", async ({ ae, fixture, expectFrame, testInfo }) => {
  const late = (globalThis.__late ??= {});
  setTimeout(() => {
    const attempt = (name, fn) => {
      try { fn(); late[name] = "no-throw"; }
      catch (error) { late[name] = error.name; }
    };
    attempt("ae", () => ae.version());
    attempt("attach", () => fixture.attach("late.txt", "late"));
    attempt("project", () => fixture.project("fixture.aep"));
    attempt("expectFrame", () => expectFrame({}));
    attempt("expect", () => expect(1).toBe(1));
    late.attachPath = join(testInfo.outputDir, "late.txt");
  }, 150);
  await new Promise(() => {});
});
test("the next test runs clean", async () => {
  const late = globalThis.__late;
  expect(late.ae).toBe("TestContextRevokedError");
  expect(late.attach).toBe("TestContextRevokedError");
  expect(late.project).toBe("TestContextRevokedError");
  expect(late.expectFrame).toBe("TestContextRevokedError");
  // expect is a pure assertion helper, not a handle on test state: it still works.
  expect(late.expect).toBe("no-throw");
  expect(existsSync(late.attachPath)).toBe(false);
});
`,
    );

    const summary = await run(
      options(file, { drainTimeoutMs: 400, timeoutMs: 100 }),
    );

    const [first, second] = summary.results;
    expect(first).toMatchObject({
      status: "timed-out",
      failure: { name: "TestTimeoutError", bodyStillRunning: true },
      cleanup: { status: "ok", quit: true },
    });
    // Teardown succeeded, so the run moved on — and the zombie's late work
    // was refused instead of reaching the host or the results directory.
    expect(second).toMatchObject({ status: "passed" });
    expect(exitCodeFor(summary)).toBe(1);
  });

  it("is already revoked while the runner drains a late-settling body", async () => {
    const file = writeSpec(
      "drain-zombie.spec.ts",
      `
test("settles during the drain", async ({ ae }) => {
  await globalThis.__gate2;
  try {
    await ae.version();
    globalThis.__late2 = "no-throw";
  } catch (error) {
    globalThis.__late2 = error.name;
  }
});
test("the next test observes the refusal", async () => {
  expect(globalThis.__late2).toBe("TestContextRevokedError");
});
`,
    );
    let release!: () => void;
    (globalThis as { __gate2?: Promise<void> }).__gate2 = new Promise<void>(
      (resolvePromise) => {
        release = resolvePromise;
      },
    );
    (globalThis as { __late2?: string | undefined }).__late2 = undefined;

    const controller = new AbortController();
    const pending = run(
      options(file, { drainTimeoutMs: 2_000, timeoutMs: 100, signal: controller.signal }),
    );
    // Let the body time out, then release it inside the drain window.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    release();
    const summary = await pending;
    controller.abort();

    const [first, second] = summary.results;
    expect(first).toMatchObject({ status: "timed-out" });
    // The body settled inside the drain, so it is not flagged as still
    // running — but its post-budget call was already refused.
    expect(first?.failure?.bodyStillRunning).toBeUndefined();
    expect(second).toMatchObject({ status: "passed" });
    expect((globalThis as { __late2?: string }).__late2).toBe("TestContextRevokedError");
  });

  it("revokes handles a passing body left behind in detached work", async () => {
    const file = writeSpec(
      "pass-zombie.spec.ts",
      `
test("passes and leaves a detached worker", async ({ ae, fixture }) => {
  const late = (globalThis.__late3 ??= {});
  let release;
  globalThis.__gate3 = new Promise((resolvePromise) => { release = resolvePromise; });
  globalThis.__zombie3 = (async () => {
    await globalThis.__gate3;
    try { await ae.version(); late.ae = "no-throw"; }
    catch (error) { late.ae = error.name; }
    try { await fixture.attach("zombie.txt", "zombie"); late.attach = "no-throw"; }
    catch (error) { late.attach = error.name; }
  })();
  globalThis.__release3 = release;
});
test("the observer releases and checks the zombie", async () => {
  globalThis.__release3();
  await globalThis.__zombie3;
  expect(globalThis.__late3.ae).toBe("TestContextRevokedError");
  expect(globalThis.__late3.attach).toBe("TestContextRevokedError");
});
`,
    );

    const summary = await run(options(file));

    expect(summary.results.map((result) => result.status)).toEqual(["passed", "passed"]);
    expect((globalThis as { __late3?: Record<string, string> }).__late3).toEqual({
      ae: "TestContextRevokedError",
      attach: "TestContextRevokedError",
    });
  });
});

describe("report.json during the run", () => {
  it("is on disk after every result, marked partial until the final write", async () => {
    const file = writeSpec(
      "two.spec.ts",
      `
test("first", async ({ ae }) => { await ae.version(); });
test("second", async ({ ae }) => { await ae.version(); });
`,
    );
    const snapshots: { partial: boolean | undefined; count: number }[] = [];
    await run(
      options(file, {
        onResult: () => {
          const report = readReport();
          snapshots.push({ partial: report.partial, count: report.results.length });
        },
      }),
    );

    // Each onResult observed a report that already contained its result,
    // and every intermediate snapshot was marked partial.
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({ partial: true, count: 1 });
    expect(snapshots[1]).toMatchObject({ partial: true, count: 2 });
    const final = readReport();
    expect(final.partial).toBeUndefined();
    expect(final.results).toHaveLength(2);
  });
});
