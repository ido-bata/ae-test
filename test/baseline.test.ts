/**
 * Snapshot baseline lifecycle (Issue #33).
 *
 * Baselines moved out of the results directory into a committed,
 * environment-scoped tree. These tests pin the contract a consumer relies on:
 * a clean checkout reuses the same baselines, a normal run never writes them,
 * pre-0.2 results-directory baselines still read, and different environments
 * never share a baseline.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeAfterEffectsTransport } from "@ido-bata/ae-a8n/testing";
import type { HostTransport } from "@ido-bata/ae-a8n";

import { clearRegistry, run } from "../dist/index.js";
import type { RunOptions } from "../dist/index.js";

let dir: string;
let specsDir: string;
let projectDir: string;
let baselineDir: string;

beforeEach(() => {
  clearRegistry();
  dir = mkdtempSync(join(tmpdir(), "ae-test-baseline-"));
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

function writeSpec(name: string, body: string): string {
  const path = join(specsDir, name);
  writeFileSync(
    path,
    `import { test, expectFrame } from "${resolve(import.meta.dirname, "..", "dist", "index.js")}";\n${body}`,
    "utf-8",
  );
  return path;
}

const SNAPSHOT_SPEC = `
test("renders a frame", async ({ ae, fixture, expectFrame }) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const comp = await project.comp("Main");
  const frame = await comp.renderFrame(0);
  await expectFrame(frame).toMatchSnapshot("frame");
});
`;

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

/** Every file under `root` as `relative path -> contents`, sorted. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        out[path.slice(root.length + 1)] = readFileSync(path, "utf-8");
      }
    }
  };
  walk(root);
  return out;
}

describe("snapshot baselines", () => {
  it("records baselines under a per-environment directory", async () => {
    const spec = writeSpec("snapshot.spec.ts", SNAPSHOT_SPEC);
    const summary = await run(options(spec, "results-1", { updateSnapshots: true }));

    expect(summary.results[0]?.status).toBe("passed");
    const envDirs = readdirSync(baselineDir, { withFileTypes: true });
    expect(envDirs).toHaveLength(1);
    expect(envDirs[0]?.name).toBe("fake-in-process");
    const files = readdirSync(join(baselineDir, "fake-in-process"));
    expect(files.some((name) => name.endsWith(".sha256"))).toBe(true);
    expect(files.some((name) => name.endsWith(".png"))).toBe(true);
    // Nothing was written into the results directory.
    expect(existsSync(join(dir, "results-1", "__snapshots__"))).toBe(false);
  });

  it("reuses the same baselines from a clean results directory", async () => {
    const spec = writeSpec("snapshot.spec.ts", SNAPSHOT_SPEC);
    await run(options(spec, "results-1", { updateSnapshots: true }));
    clearRegistry();

    // A different results directory stands in for a clean checkout: the
    // baseline tree is the only thing carried over.
    const second = await run(options(spec, "results-2"));
    expect(second.results[0]?.status).toBe("passed");
  });

  it("never writes baselines on a normal run", async () => {
    const spec = writeSpec("snapshot.spec.ts", SNAPSHOT_SPEC);
    await run(options(spec, "results-1", { updateSnapshots: true }));
    const before = tree(baselineDir);
    clearRegistry();

    const second = await run(options(spec, "results-2"));
    expect(second.results[0]?.status).toBe("passed");
    expect(tree(baselineDir)).toEqual(before);
  });

  it("reads pre-0.2 baselines from the results directory as a fallback", async () => {
    const spec = writeSpec("snapshot.spec.ts", SNAPSHOT_SPEC);
    await run(options(spec, "results-1", { updateSnapshots: true }));

    // Recreate the old layout: the same files directly under
    // <results-dir>/__snapshots__/, with an empty baselineDir.
    const legacyDir = join(dir, "results-legacy", "__snapshots__");
    mkdirSync(legacyDir, { recursive: true });
    const envDir = join(baselineDir, "fake-in-process");
    for (const name of readdirSync(envDir)) {
      writeFileSync(join(legacyDir, name), readFileSync(join(envDir, name)));
    }
    rmSync(baselineDir, { recursive: true, force: true });
    clearRegistry();

    const summary = await run({
      ...options(spec, "results-legacy"),
      // The fallback lives inside this run's own results directory.
      resultsDir: join(dir, "results-legacy"),
    });
    expect(summary.results[0]?.status).toBe("passed");
    // The fallback is read-only: the baseline tree was not recreated.
    expect(existsSync(baselineDir)).toBe(false);
  });

  it("keeps different transports in different baseline namespaces", async () => {
    // The fake's `kind` is a literal type, so a different namespace needs a
    // transport of its own — delegating to the fake keeps the host behaviour.
    class OtherTransport implements HostTransport {
      readonly kind = "other-transport";
      readonly #inner = new FakeAfterEffectsTransport();
      available() {
        return this.#inner.available();
      }
      launch() {
        return this.#inner.launch();
      }
      invoke(entryScriptPath: string) {
        return this.#inner.invoke(entryScriptPath);
      }
      ownership() {
        return this.#inner.ownership();
      }
      close() {
        return this.#inner.close();
      }
    }

    const spec = writeSpec("snapshot.spec.ts", SNAPSHOT_SPEC);
    await run(options(spec, "results-1", { updateSnapshots: true }));
    clearRegistry();

    // The same render under a different transport kind must not see the
    // fake host's baselines: it reports a missing baseline, not a match.
    const other = await run(
      options(spec, "results-2", { transport: new OtherTransport() }),
    );
    expect(other.results[0]?.status).toBe("failed");
    expect(other.results[0]?.failure?.message).toContain("no snapshot baseline");

    // And updating under the other kind writes its own namespace.
    clearRegistry();
    const updated = await run(
      options(spec, "results-3", {
        transport: new OtherTransport(),
        updateSnapshots: true,
      }),
    );
    expect(updated.results[0]?.status).toBe("passed");
    const envNames = readdirSync(baselineDir);
    expect(envNames).toHaveLength(2);
    expect(envNames).toContain("fake-in-process");
    expect(envNames.some((name) => name.startsWith("other-transport-"))).toBe(true);
  });

  it("refuses two snapshot names that sanitize to the same baseline file", async () => {
    // "a/b" and "a-b" both become "a-b" after sanitization: without the
    // collision check they would silently share one baseline.
    const spec = writeSpec(
      "collision.spec.ts",
      `
test("colliding names", async ({ ae, fixture, expectFrame }) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const comp = await project.comp("Main");
  const frame = await comp.renderFrame(0);
  await expectFrame(frame).toMatchSnapshot("a/b");
  await expectFrame(frame).toMatchSnapshot("a-b");
});
`,
    );
    const summary = await run(options(spec, "collision", { updateSnapshots: true }));
    expect(summary.results[0]?.status).toBe("failed");
    expect(summary.results[0]?.failure?.message).toMatch(/share one baseline/);
  });
});
