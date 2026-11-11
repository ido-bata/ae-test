/**
 * Runner behaviour that a passing suite cannot demonstrate: what happens when
 * a test times out, throws, or never opens its session.
 *
 * These are the cases where a leaked After Effects process or a silently
 * green run would be expensive, so they are pinned explicitly.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeAfterEffectsTransport } from "@ido-bata/ae-a8n/testing";

import {
  countByStatus,
  exitCodeFor,
  formatFailure,
  hasFailures,
  run,
} from "../dist/index.js";
import type { RunOptions } from "../dist/index.js";

let resultsDir: string;
let specsDir: string;
let projectDir: string;

beforeEach(() => {
  resultsDir = mkdtempSync(join(tmpdir(), "ae-test-runner-"));
  specsDir = mkdtempSync(join(tmpdir(), "ae-test-specs-"));
  projectDir = mkdtempSync(join(tmpdir(), "ae-test-projects-"));
  writeFileSync(join(projectDir, "fixture.aep"), "placeholder");
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

function options(file: string, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    files: [file],
    resultsDir,
    projectsDir: projectDir,
    transport: new FakeAfterEffectsTransport(),
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe("runner", () => {
  it("opens a fresh session per test and closes every one", async () => {
    const inner = new FakeAfterEffectsTransport();
    const counting: FakeAfterEffectsTransport & { launches: number; closes: number } =
      Object.assign(inner, { launches: 0, closes: 0 });
    const realLaunch = counting.launch.bind(counting);
    const realClose = counting.close.bind(counting);
    counting.launch = () => {
      counting.launches += 1;
      return realLaunch();
    };
    counting.close = () => {
      counting.closes += 1;
      return realClose();
    };

    const file = writeSpec(
      "two.spec.ts",
      `
test("first", async ({ ae }) => { expect(typeof ae.version).toBe("function"); });
test("second", async ({ ae }) => { expect(typeof ae.version).toBe("function"); });
`,
    );

    const summary = await run(options(file, { transport: counting }));
    expect(summary.results).toHaveLength(2);
    expect(counting.launches).toBe(2);
    expect(counting.closes).toBe(2);
  });

  it("tears the session down even when the test throws", async () => {
    const transport = new FakeAfterEffectsTransport();
    const file = writeSpec(
      "boom.spec.ts",
      `
test("explodes", async ({ ae }) => { await ae.version(); throw new Error("deliberate"); });
`,
    );

    const summary = await run(options(file, { transport }));
    expect(summary.results[0]?.status).toBe("failed");
    expect(summary.results[0]?.failure?.message).toBe("deliberate");
    expect(transport.closed).toBe(true);
  });

  it("tears the session down when the test times out", async () => {
    const inner = new FakeAfterEffectsTransport();
    let launches = 0;
    const realLaunch = inner.launch.bind(inner);
    inner.launch = () => {
      launches += 1;
      return realLaunch();
    };
    const file = writeSpec(
      "slow.spec.ts",
      `
test("never finishes", async () => { await new Promise(() => {}); });
`,
    );

    const summary = await run(options(file, { transport: inner, timeoutMs: 150 }));
    expect(summary.results[0]?.status).toBe("timed-out");
    expect(summary.results[0]?.failure?.message).toMatch(/exceeded its 150ms budget/);
    expect(inner.closed).toBe(true);
    // A timeout ends the wait; it does not re-send the test or launch again.
    expect(launches).toBe(1);
    expect(summary.results).toHaveLength(1);
  });

  it("honours a per-test timeout override", async () => {
    const transport = new FakeAfterEffectsTransport();
    const file = writeSpec(
      "override.spec.ts",
      `
test("gives up quickly", async () => { await new Promise(() => {}); }, { timeoutMs: 100 });
`,
    );

    const summary = await run(options(file, { transport, timeoutMs: 30_000 }));
    expect(summary.results[0]?.status).toBe("timed-out");
    expect(summary.results[0]?.failure?.message).toMatch(/100ms/);
  });

  it("points a failure at the operations that ran just before it", async () => {
    const file = writeSpec(
      "trace.spec.ts",
      `
test("fails after work", async ({ ae, fixture, expect }) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const comp = await project.comp("Main");
  expect(comp.name).toBe("wrong on purpose");
});
`,
    );

    const summary = await run(options(file));
    const failure = summary.results[0]?.failure;
    expect(failure?.lastOperations.length).toBeGreaterThan(0);
    expect(failure?.lastOperations.join(" ")).toMatch(/project\.open \(ok\)/);
  });

  it("reports a missing project fixture as a setup error, not a test failure", async () => {
    const file = writeSpec(
      "nofixture.spec.ts",
      `
test("wants a fixture that is not there", async ({ ae, fixture }) => {
  await ae.openProject(fixture.project("absent.aep"));
});
`,
    );

    const summary = await run(options(file));
    expect(summary.results[0]?.status).toBe("failed");
    expect(summary.results[0]?.failure?.message).toMatch(/project fixture not found/);
    // The message must name what *is* there, or the reader has to go look.
    expect(summary.results[0]?.failure?.message).toContain("fixture.aep");
  });

  it("skips a test declared as skipped", async () => {
    const file = writeSpec(
      "skip.spec.ts",
      `
import { skip } from "${resolve(import.meta.dirname, "..", "dist", "index.js")}";
skip("not yet", async () => { throw new Error("should not run"); });
`,
    );

    const summary = await run(options(file));
    expect(summary.results[0]?.status).toBe("skipped");
    expect(countByStatus(summary.results).skipped).toBe(1);
  });

  it("returns zero tests and a passing exit code for an empty selection", async () => {
    const file = writeSpec("noop.spec.ts", "");
    const summary = await run(options(file, { grep: "nothing matches this" }));
    expect(summary.results).toHaveLength(0);
    expect(exitCodeFor(summary)).toBe(0);
  });

  it("counts statuses and flags failures", async () => {
    const file = writeSpec(
      "mixed.spec.ts",
      `
test("passes", async () => {});
test("fails", async () => { throw new Error("nope"); });
`,
    );

    const summary = await run(options(file));
    expect(countByStatus(summary.results)).toEqual({
      passed: 1,
      failed: 1,
      "timed-out": 0,
      skipped: 0,
      blocked: 0,
    });
    expect(hasFailures(summary.results)).toBe(true);
    expect(exitCodeFor(summary)).toBe(1);
  });

  it("keeps the trace as an artifact even for a failing test", async () => {
    const file = writeSpec(
      "failing-artifacts.spec.ts",
      `
test("works then fails", async ({ ae, fixture, expect }) => {
  await ae.openProject(fixture.project("fixture.aep"));
  expect(1).toBe(2);
});
`,
    );

    const summary = await run(options(file));
    const trace = summary.results[0]?.artifacts.find((artifact) => artifact.kind === "trace");
    expect(trace).toBeDefined();
    expect(existsSync(trace?.path ?? "")).toBe(true);
  });

  it("formats a failure with the operations, not just a stack", async () => {
    const file = writeSpec(
      "formatted.spec.ts",
      `
test("fails", async ({ ae, fixture, expect }) => {
  await ae.openProject(fixture.project("fixture.aep"));
  expect(1).toBe(2);
});
`,
    );

    const summary = await run(options(file));
    const text = formatFailure(summary.results[0]!);
    expect(text).toContain("AssertionError");
    expect(text).toContain("last operations:");
    expect(text).toContain("project.open (ok)");
  });

  it("records what the test ran against: account, host version and fixture bytes", async () => {
    const file = writeSpec(
      "facts.spec.ts",
      `
test("opens the fixture", async ({ ae, fixture }) => {
  await ae.openProject(fixture.project("fixture.aep"));
});
`,
    );

    const summary = await run(options(file));
    const session = summary.results[0]?.session;
    expect(session).toBeDefined();
    // The process's own uid is the account the test body ran as; in an
    // isolated session that is the session's account, not the caller's.
    expect(session?.uid).toBe(typeof process.getuid === "function" ? process.getuid() : null);
    expect(session?.asid === null || typeof session?.asid === "number").toBe(true);
    expect(session?.ae?.version).toBeTruthy();
    expect(session?.extensions).toEqual([]);
    // The digest is of the bytes the test resolved, recorded once.
    const path = join(projectDir, "fixture.aep");
    expect(session?.fixtures).toEqual([
      {
        name: "fixture.aep",
        path,
        sha256: createHash("sha256").update("placeholder").digest("hex"),
      },
    ]);
  });

  it("records a host script's declared extension methods", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ae-test-extension-facts-"));
    const extension = join(scratch, "host-extension.ts");
    writeFileSync(
      extension,
      `const extension = {
  name: "facts",
  version: "1.0.0",
  methods: [{ name: "facts.host.version", source: "function (params) { return app.version; }" }],
};
export default extension;
`,
      "utf-8",
    );
    const hostScript = join(scratch, "host.generated.js");
    execFileSync(
      process.execPath,
      [
        join(resolve(import.meta.dirname, ".."), "node_modules", "@ido-bata", "ae-a8n", "dist", "cli.js"),
        "extension",
        "build",
        "--extension",
        extension,
        "--out",
        hostScript,
      ],
      { encoding: "utf-8" },
    );
    const file = writeSpec(
      "extension-facts.spec.ts",
      `
test("declares one method", async ({ ae }) => {
  await ae.extensionMethods();
});
`,
    );

    try {
      const summary = await run(options(file, { hostScript }));
      expect(summary.results[0]?.status).toBe("passed");
      expect(summary.results[0]?.session?.extensions).toEqual(["facts.host.version"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("attaches arbitrary files to the results directory", async () => {
    const file = writeSpec(
      "attach.spec.ts",
      `
test("attaches", async ({ fixture }) => {
  await fixture.attach("notes.txt", "why this test exists");
});
`,
    );

    const summary = await run(options(file));
    const attachment = summary.results[0]?.artifacts.find(
      (artifact) => artifact.kind === "attachment",
    );
    expect(attachment?.name).toBe("notes.txt");
    expect(existsSync(attachment?.path ?? "")).toBe(true);
  });

  it("creates the results directory tree up front", async () => {
    const nested = join(resultsDir, "deeply", "nested");
    const file = writeSpec("nested.spec.ts", `test("ok", async () => {});`);
    await run(options(file, { resultsDir: nested }));
    expect(existsSync(join(nested, "report.json"))).toBe(true);
    expect(existsSync(join(nested, "__snapshots__"))).toBe(true);
  });
});

describe("registry", () => {
  it("rejects a declaration with no function", async () => {
    const file = join(specsDir, "bad.spec.ts");
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(
      file,
      `import { test } from "${resolve(import.meta.dirname, "..", "dist", "index.js")}";\ntest("bad", null);\n`,
      "utf-8",
    );
    await expect(run(options(file))).rejects.toThrow(/needs a function/);
  });
});
