/**
 * Project config and spec discovery (Issue #34).
 *
 * The contract a consumer relies on: `ae-test.config.json` replaces repeated
 * flags, CLI beats config beats defaults, spec selection is reproducible, and
 * a discovery that finds nothing is a setup error — never a silent fake-host
 * run and never a green zero-test pass.
 *
 * CLI cases spawn the built `dist/cli.js` in a scratch consumer directory,
 * the same way `check-packed-package.js` does, against the fake host only.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONFIG_FILE_NAME,
  ConfigError,
  DEFAULT_SPEC_PATTERNS,
  discoverSpecs,
  findConfigFile,
  loadConfigFile,
} from "../dist/index.js";

const CLI = resolve(import.meta.dirname, "..", "dist", "cli.js");
const DIST_URL = pathToFileURL(resolve(import.meta.dirname, "..", "dist", "index.js")).href;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ae-test-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function writeSpec(dirPath: string, name: string, title = "a test"): string {
  const path = join(dirPath, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `import { test, expect } from ${JSON.stringify(DIST_URL)};\n` +
      `test(${JSON.stringify(title)}, async ({ expect }) => { expect(1).toBe(1); });\n`,
    "utf-8",
  );
  return path;
}

/** Runs the built CLI; returns { status, stdout, stderr }. */
function cli(args: readonly string[], cwd: string) {
  const run = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf-8" });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

describe("config file", () => {
  it("loads a valid config and resolves its directory", () => {
    const configPath = join(dir, "project", CONFIG_FILE_NAME);
    writeJson(configPath, { specs: ["tests/**/*.spec.ts"], host: "fake", timeoutMs: 5000 });

    const loaded = loadConfigFile(configPath);
    expect(loaded.dir).toBe(join(dir, "project"));
    expect(loaded.config.specs).toEqual(["tests/**/*.spec.ts"]);
    expect(loaded.config.host).toBe("fake");
    expect(loaded.config.timeoutMs).toBe(5000);
    expect(findConfigFile(join(dir, "project"))).toBe(configPath);
    expect(findConfigFile(dir)).toBeUndefined();
  });

  it("rejects invalid JSON, unknown keys and wrong types", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json", "utf-8");
    expect(() => loadConfigFile(bad)).toThrow(ConfigError);

    writeJson(bad, { nope: true });
    expect(() => loadConfigFile(bad)).toThrow(/unknown key "nope"/);

    writeJson(bad, { timeoutMs: "fast" });
    expect(() => loadConfigFile(bad)).toThrow(/timeoutMs/);

    writeJson(bad, { host: "maybe" });
    expect(() => loadConfigFile(bad)).toThrow(/"real" or "fake"/);

    writeJson(bad, { specs: "tests/**" });
    expect(() => loadConfigFile(bad)).toThrow(/specs/);

    writeJson(bad, { hostEnvironment: { A: 1 } });
    expect(() => loadConfigFile(bad)).toThrow(/hostEnvironment\.A/);
  });
});

describe("spec discovery", () => {
  it("finds spec files, skips node_modules and dot-directories, sorts", () => {
    writeSpec(dir, "b.spec.ts");
    writeSpec(dir, "a.spec.mjs");
    writeSpec(dir, "nested/c.spec.js");
    writeSpec(dir, "node_modules/dep/d.spec.ts");
    writeSpec(dir, ".hidden/e.spec.ts");
    writeSpec(dir, "not-a-spec.test.ts");
    writeFileSync(join(dir, "plain.ts"), "export {};\n", "utf-8");

    const found = discoverSpecs(DEFAULT_SPEC_PATTERNS, dir);
    expect(found.map((path) => path.slice(dir.length + 1))).toEqual([
      "a.spec.mjs",
      "b.spec.ts",
      "nested/c.spec.js",
    ]);
  });

  it("honours explicit patterns and deduplicates overlaps", () => {
    writeSpec(dir, "one.spec.ts");
    writeSpec(dir, "two.spec.ts");
    const found = discoverSpecs(["*.spec.ts", "one.spec.ts", "two.spec.ts"], dir);
    expect(found).toHaveLength(2);
  });
});

describe("CLI with config and discovery", () => {
  it("runs a suite from ae-test.config.json alone", () => {
    const project = join(dir, "project");
    writeSpec(project, "suite/one.spec.mjs");
    writeJson(join(project, CONFIG_FILE_NAME), {
      specs: ["suite/**/*.spec.mjs"],
      host: "fake",
      resultsDir: "out",
    });

    const result = cli([], project);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(
      readFileSync(join(project, "out", "report.json"), "utf-8"),
    ) as { results: Array<{ status: string }> };
    expect(report.results.map((r) => r.status)).toEqual(["passed"]);
  });

  it("resolves config paths against the config file, not the cwd", () => {
    const project = join(dir, "project");
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writeSpec(project, "suite/one.spec.mjs");
    writeJson(join(project, CONFIG_FILE_NAME), {
      specs: ["suite/**/*.spec.mjs"],
      host: "fake",
      resultsDir: "out",
      projectsDir: "fixtures",
    });

    const result = cli(["--config", join(project, CONFIG_FILE_NAME)], elsewhere);
    expect(result.status, result.stderr).toBe(0);
    // The report landed under the config's directory, proving the relative
    // paths resolved there rather than under the invocation cwd.
    expect(readFileSync(join(project, "out", "report.json"), "utf-8")).toContain("passed");
  });

  it("discovers specs with default patterns when nothing selects them", () => {
    const project = join(dir, "project");
    writeSpec(project, "tests/alpha.spec.mjs");
    writeSpec(project, "tests/beta.spec.ts");

    const result = cli(["--fake-host", "--results-dir", join(dir, "results")], project);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(
      readFileSync(join(dir, "results", "report.json"), "utf-8"),
    ) as { results: Array<{ title: string }> };
    expect(report.results).toHaveLength(2);
  });

  it("exits 2 when discovery finds nothing", () => {
    const project = join(dir, "empty");
    mkdirSync(project, { recursive: true });
    const result = cli([], project);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no test files found");
  });

  it("exits 2 when --spec matches nothing", () => {
    const project = join(dir, "project");
    writeSpec(project, "one.spec.mjs");
    const result = cli(["--spec", "nothing/**/*.spec.mjs"], project);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no test files found");
  });

  it("prefers positional files over config specs", () => {
    const project = join(dir, "project");
    writeSpec(project, "chosen/chosen.spec.mjs", "the chosen one");
    writeSpec(project, "other/other.spec.mjs", "the other one");
    writeJson(join(project, CONFIG_FILE_NAME), {
      specs: ["other/**/*.spec.mjs"],
      host: "fake",
    });

    const result = cli(["chosen/chosen.spec.mjs"], project);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(
      readFileSync(join(project, ".ae-test-results", "report.json"), "utf-8"),
    ) as { results: Array<{ title: string }> };
    expect(report.results.map((r) => r.title)).toEqual(["the chosen one"]);
  });

  it("rejects files combined with --spec, and fake with real host", () => {
    const project = join(dir, "project");
    const spec = writeSpec(project, "one.spec.mjs");
    expect(cli([spec, "--spec", "*.spec.mjs"], project).status).toBe(2);
    expect(cli(["--fake-host", "--real-host"], project).status).toBe(2);
  });

  it("exits 2 for a missing explicit --config", () => {
    const result = cli(["--config", join(dir, "nope.json")], dir);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("cannot read config");
  });

  it("exits 2 for an invalid config file", () => {
    const project = join(dir, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, CONFIG_FILE_NAME), "{ broken", "utf-8");
    const result = cli([], project);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not valid JSON");
  });

  it("lets the CLI override config values", () => {
    const project = join(dir, "project");
    writeSpec(project, "suite/one.spec.mjs", "config test");
    writeSpec(project, "suite/two.spec.mjs", "cli test");
    writeJson(join(project, CONFIG_FILE_NAME), {
      specs: ["suite/**/*.spec.mjs"],
      host: "fake",
      grep: "config",
    });

    // --grep on the command line replaces the config's grep.
    const result = cli(["--grep", "cli"], project);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(
      readFileSync(join(project, ".ae-test-results", "report.json"), "utf-8"),
    ) as { results: Array<{ title: string }> };
    expect(report.results.map((r) => r.title)).toEqual(["cli test"]);
  });
});
