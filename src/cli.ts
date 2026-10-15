#!/usr/bin/env node
/**
 * `ae-test` — run a suite.
 *
 * Exit code is the contract: 0 when everything passed or was skipped, 1 when
 * anything failed or timed out, 2 on a setup problem (no test files, a bad
 * flag). CI depends on that distinction — 1 means "your tests are red", 2 means
 * "the run never happened" and retrying will not help.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { HostTransport } from "@ido-bata/ae-a8n";

import { exitCodeFor, formatRun } from "./report.js";
import { run, type RunOptions } from "./runner.js";

const USAGE = `ae-test <files...> [options]

Options:
  --results-dir <dir>     Where artifacts, traces, and snapshots go
                          (default: .ae-test-results)
  --projects-dir <dir>    Where .aep fixtures live (default: fixtures)
  --timeout <ms>          Per-test budget (default: 60000)
  --grep <substring>      Only run tests whose title contains this
  --update-snapshots      Record snapshot baselines instead of comparing
  --fake-host             Run against the in-repo fake After Effects host
                          instead of a real installation
  -h, --help              Show this message
`;

type CliOptions = {
  resultsDir?: string;
  projectsDir?: string;
  timeoutMs?: number;
  grep?: string;
  updateSnapshots?: boolean;
  fakeHost?: boolean;
};

type Parsed = {
  files: string[];
  options: CliOptions;
  error?: string;
};

function parse(argv: readonly string[]): Parsed {
  const files: string[] = [];
  const options: Parsed["options"] = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const next = (): string | undefined => {
      i += 1;
      return argv[i];
    };

    switch (arg) {
      case "-h":
      case "--help":
        return { files: [], options, error: "help" };
      case "--fake-host":
        options.fakeHost = true;
        break;
      case "--update-snapshots":
        options.updateSnapshots = true;
        break;
      case "--results-dir": {
        const value = next();
        if (value === undefined) return { files, options, error: "--results-dir needs a value" };
        options.resultsDir = value;
        break;
      }
      case "--projects-dir": {
        const value = next();
        if (value === undefined) return { files, options, error: "--projects-dir needs a value" };
        options.projectsDir = value;
        break;
      }
      case "--timeout": {
        const value = next();
        const parsed = Number(value);
        if (value === undefined || !Number.isFinite(parsed) || parsed <= 0) {
          return { files, options, error: "--timeout needs a positive number" };
        }
        options.timeoutMs = parsed;
        break;
      }
      case "--grep": {
        const value = next();
        if (value === undefined) return { files, options, error: "--grep needs a value" };
        options.grep = value;
        break;
      }
      default:
        if (arg.startsWith("-")) {
          return { files, options, error: `unknown option: ${arg}` };
        }
        files.push(arg);
    }
  }
  return { files, options };
}

async function main(): Promise<number> {
  const { files, options, error } = parse(process.argv.slice(2));

  if (error === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (error !== undefined) {
    process.stderr.write(`${error}\n\n${USAGE}`);
    return 2;
  }
  if (files.length === 0) {
    process.stderr.write(`no test files given\n\n${USAGE}`);
    return 2;
  }

  const missing = files.filter((file) => !existsSync(resolve(file)));
  if (missing.length > 0) {
    process.stderr.write(`test file not found: ${missing.join(", ")}\n`);
    return 2;
  }

  // The fake host is opt-in and explicit. Silently substituting a fake for a
  // real After Effects would be the worst possible default: every test would
  // go green while proving nothing.
  const transport = options.fakeHost === true ? await createFakeTransport() : undefined;

  const runOptions: RunOptions = {
    files,
    ...(options.resultsDir === undefined ? {} : { resultsDir: options.resultsDir }),
    ...(options.projectsDir === undefined ? {} : { projectsDir: options.projectsDir }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.grep === undefined ? {} : { grep: options.grep }),
    ...(options.updateSnapshots === undefined ? {} : { updateSnapshots: options.updateSnapshots }),
    ...(transport === undefined ? {} : { transport }),
    onResult: (result) => {
      if (result.status === "failed" || result.status === "timed-out") {
        process.stderr.write(`  ✗ ${result.title}\n`);
      }
    },
  };

  const summary = await run(runOptions);
  process.stdout.write(`${formatRun(summary)}\n`);
  return exitCodeFor(summary);
}

async function createFakeTransport(): Promise<HostTransport> {
  // Imported lazily: a real run should not pay for the fake, and the fake is
  // only meaningful in this repository's own tests.
  const { FakeAfterEffectsTransport } = await import("@ido-bata/ae-a8n/testing");
  return new FakeAfterEffectsTransport();
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`ae-test failed to start: ${(error as Error).message}\n`);
    process.exitCode = 2;
  });
