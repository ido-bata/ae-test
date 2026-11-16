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
  --capability <id>       Only run tests declaring this capability ID
                          (repeatable)
  --update-snapshots      Record snapshot baselines instead of comparing
  --host-script <file>    Host script built by "ae-a8n extension build", so a
                          project's own static host methods can be called
  --fake-host             Run against the in-repo fake After Effects host
                          instead of a real installation
  --conformance           Write conformance.json evidence beside report.json
  --capability-catalog <path>  ae-devtools catalog.json to validate capability IDs
  --source-sha <sha>      Git SHA of the code under test for the evidence record
  --run-id <id>           Conformance run id (default: generated)
  --conformance-out <path>  Write conformance evidence here instead
  -h, --help              Show this message
`;

type CliOptions = {
  resultsDir?: string;
  projectsDir?: string;
  timeoutMs?: number;
  grep?: string;
  capabilities?: string[];
  updateSnapshots?: boolean;
  hostScript?: string;
  fakeHost?: boolean;
  conformance?: boolean;
  capabilityCatalog?: string;
  sourceSha?: string;
  runId?: string;
  conformanceOut?: string;
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
      case "--capability": {
        const value = next();
        if (value === undefined) return { files, options, error: "--capability needs a value" };
        (options.capabilities ??= []).push(value);
        break;
      }
      case "--host-script": {
        const value = next();
        if (value === undefined) return { files, options, error: "--host-script needs a value" };
        options.hostScript = value;
        break;
      }
      case "--conformance":
        options.conformance = true;
        break;
      case "--capability-catalog": {
        const value = next();
        if (value === undefined) return { files, options, error: "--capability-catalog needs a value" };
        options.capabilityCatalog = value;
        break;
      }
      case "--source-sha": {
        const value = next();
        if (value === undefined) return { files, options, error: "--source-sha needs a value" };
        options.sourceSha = value;
        break;
      }
      case "--run-id": {
        const value = next();
        if (value === undefined) return { files, options, error: "--run-id needs a value" };
        options.runId = value;
        break;
      }
      case "--conformance-out": {
        const value = next();
        if (value === undefined) return { files, options, error: "--conformance-out needs a value" };
        options.conformanceOut = value;
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
  if (
    options.conformance !== true &&
    (options.capabilityCatalog !== undefined ||
      options.sourceSha !== undefined ||
      options.runId !== undefined ||
      options.conformanceOut !== undefined)
  ) {
    process.stderr.write("conformance options require --conformance\n\n" + USAGE);
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
    ...(options.capabilities === undefined
      ? {}
      : { capabilityFilter: options.capabilities }),
    ...(options.updateSnapshots === undefined ? {} : { updateSnapshots: options.updateSnapshots }),
    ...(options.hostScript === undefined ? {} : { hostScript: options.hostScript }),
    ...(transport === undefined ? {} : { transport }),
    ...(options.conformance === true
      ? {
          conformance: {
            host: options.fakeHost === true ? ("fake" as const) : ("real" as const),
            ...(options.capabilityCatalog === undefined
              ? {}
              : { catalogPath: options.capabilityCatalog }),
            ...(options.sourceSha === undefined ? {} : { sourceSha: options.sourceSha }),
            ...(options.runId === undefined ? {} : { runId: options.runId }),
            ...(options.conformanceOut === undefined
              ? {}
              : { outPath: options.conformanceOut }),
          },
        }
      : {}),
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
