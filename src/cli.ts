#!/usr/bin/env node
/**
 * `ae-test` — run a suite.
 *
 * Exit code is the contract: 0 when everything passed or was skipped, 1 when
 * anything failed or timed out, 2 on a setup problem (no test files, a bad
 * flag). CI depends on that distinction — 1 means "your tests are red", 2 means
 * "the run never happened" and retrying will not help.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";

import type { HostTransport } from "@ido-bata/ae-a8n";

import {
  CONFIG_FILE_NAME,
  ConfigError,
  DEFAULT_SPEC_PATTERNS,
  discoverSpecs,
  findConfigFile,
  loadConfigFile,
  type AeTestConfig,
} from "./config.js";
import { exitCodeFor, formatRun } from "./report.js";
import { run, type RunOptions } from "./runner.js";

const USAGE = `ae-test [files...|--spec <glob>...] [options]

With no files and no --spec, specs are discovered with
${DEFAULT_SPEC_PATTERNS.map((pattern) => `"${pattern}"`).join(", ")} under the
project root — the config file's directory when ${CONFIG_FILE_NAME} is used.

Options:
  --config <file>        Project config (default: ./${CONFIG_FILE_NAME})
  --spec <glob>          Select spec files by glob, repeatable; relative to
                         the working directory. Exclusive with file arguments
  --real-host            Run against a real After Effects even when the
                         config says "fake"
  --results-dir <dir>     Where artifacts, traces, and the report go
                          (default: .ae-test-results)
  --baseline-dir <dir>    Where snapshot baselines live, meant to be
                          committed (default: ./__snapshots__, grouped per
                          environment). Read-only unless --update-snapshots
  --projects-dir <dir>    Where .aep fixtures live (default: fixtures)
  --timeout <ms>          Per-test body budget (default: 60000); launch
                          and teardown have their own bounds
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
  --plugin-binary <path>  Plugin binary under test; hashed into the evidence
                          (repeatable)
  --sdk-binary <path>     SDK build artifact under test; hashed into the
                          evidence (repeatable)
  -h, --help              Show this message
`;

type CliOptions = {
  config?: string;
  specs?: string[];
  realHost?: boolean;
  resultsDir?: string;
  baselineDir?: string;
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
  pluginBinaries?: string[];
  sdkBinaries?: string[];
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
      case "--config": {
        const value = next();
        if (value === undefined) return { files, options, error: "--config needs a value" };
        options.config = value;
        break;
      }
      case "--spec": {
        const value = next();
        if (value === undefined) return { files, options, error: "--spec needs a value" };
        (options.specs ??= []).push(value);
        break;
      }
      case "--real-host":
        options.realHost = true;
        break;
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
      case "--baseline-dir": {
        const value = next();
        if (value === undefined) return { files, options, error: "--baseline-dir needs a value" };
        options.baselineDir = value;
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
      case "--plugin-binary": {
        const value = next();
        if (value === undefined) return { files, options, error: "--plugin-binary needs a value" };
        (options.pluginBinaries ??= []).push(value);
        break;
      }
      case "--sdk-binary": {
        const value = next();
        if (value === undefined) return { files, options, error: "--sdk-binary needs a value" };
        (options.sdkBinaries ??= []).push(value);
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
  if (options.fakeHost === true && options.realHost === true) {
    process.stderr.write("--fake-host and --real-host are mutually exclusive\n");
    return 2;
  }
  if (files.length > 0 && options.specs !== undefined) {
    process.stderr.write("file arguments and --spec are mutually exclusive\n");
    return 2;
  }

  // Project config: explicit --config, else ./ae-test.config.json. A config
  // that cannot be read or validated is a setup error, like a bad flag.
  let config: AeTestConfig = {};
  let configDir = process.cwd();
  try {
    const configPath =
      options.config !== undefined ? resolve(options.config) : findConfigFile();
    if (configPath !== undefined) {
      const loaded = loadConfigFile(configPath);
      config = loaded.config;
      configDir = loaded.dir;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  // Spec selection, most explicit first: positional files, then --spec
  // globs, then config.specs, then the default discovery patterns.
  let specFiles: string[];
  let searched: string;
  if (files.length > 0) {
    specFiles = files;
    searched = "the given files";
  } else if (options.specs !== undefined) {
    specFiles = discoverSpecs(options.specs, process.cwd());
    searched = options.specs.map((pattern) => `"${pattern}"`).join(", ");
  } else {
    const patterns = config.specs ?? DEFAULT_SPEC_PATTERNS;
    specFiles = discoverSpecs(patterns, configDir);
    searched = patterns.map((pattern) => `"${pattern}"`).join(", ");
  }

  if (files.length > 0) {
    const missing = files.filter((file) => {
      try {
        return !statSync(resolve(file)).isFile();
      } catch {
        return true;
      }
    });
    if (missing.length > 0) {
      process.stderr.write(`test file not found: ${missing.join(", ")}\n`);
      return 2;
    }
  } else if (specFiles.length === 0) {
    process.stderr.write(
      `no test files found (${searched} under ${configDir === process.cwd() ? "the working directory" : configDir})\n`,
    );
    return 2;
  }
  if (
    options.conformance !== true &&
    (options.capabilityCatalog !== undefined ||
      options.sourceSha !== undefined ||
      options.runId !== undefined ||
      options.conformanceOut !== undefined ||
      options.pluginBinaries !== undefined ||
      options.sdkBinaries !== undefined)
  ) {
    process.stderr.write("conformance options require --conformance\n\n" + USAGE);
    return 2;
  }

  // CLI > config > default, per option. Config paths are relative to the
  // config file's directory; CLI paths stay relative to the working
  // directory, resolved downstream as before.
  const pick = <T>(cli: T | undefined, cfg: T | undefined): T | undefined => cli ?? cfg;
  const cfgPath = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : resolve(configDir, value);
  const resultsDir = pick(options.resultsDir, cfgPath(config.resultsDir));
  const baselineDir = pick(options.baselineDir, cfgPath(config.baselineDir));
  const projectsDir = pick(options.projectsDir, cfgPath(config.projectsDir));
  const timeoutMs = pick(options.timeoutMs, config.timeoutMs);
  const grep = pick(options.grep, config.grep);
  const capabilities = pick(options.capabilities, config.capabilities);
  const hostScript = pick(options.hostScript, cfgPath(config.hostScript));
  const installDir = cfgPath(config.installDir);

  // The fake host is opt-in and explicit at every level: a CLI flag, a
  // config "host", or nothing — and nothing means real. Silently substituting
  // a fake for a real After Effects would be the worst possible default:
  // every test would go green while proving nothing.
  const useFake =
    options.realHost === true ? false : options.fakeHost === true ? true : config.host === "fake";
  const transport = useFake ? await createFakeTransport() : undefined;

  const runOptions: RunOptions = {
    files: specFiles,
    ...(resultsDir === undefined ? {} : { resultsDir }),
    ...(baselineDir === undefined ? {} : { baselineDir }),
    ...(projectsDir === undefined ? {} : { projectsDir }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(grep === undefined ? {} : { grep }),
    ...(capabilities === undefined ? {} : { capabilityFilter: capabilities }),
    ...(options.updateSnapshots === undefined ? {} : { updateSnapshots: options.updateSnapshots }),
    ...(hostScript === undefined ? {} : { hostScript }),
    ...(installDir === undefined ? {} : { installDir }),
    ...(config.hostEnvironment === undefined
      ? {}
      : { hostEnvironment: config.hostEnvironment }),
    ...(transport === undefined ? {} : { transport }),
    ...(options.conformance === true
      ? {
          conformance: {
            host: useFake ? ("fake" as const) : ("real" as const),
            ...(options.capabilityCatalog === undefined
              ? {}
              : { catalogPath: options.capabilityCatalog }),
            ...(options.sourceSha === undefined ? {} : { sourceSha: options.sourceSha }),
            ...(options.runId === undefined ? {} : { runId: options.runId }),
            ...(options.conformanceOut === undefined
              ? {}
              : { outPath: options.conformanceOut }),
            ...(options.pluginBinaries === undefined
              ? {}
              : { pluginBinaries: options.pluginBinaries }),
            ...(options.sdkBinaries === undefined
              ? {}
              : { sdkBinaries: options.sdkBinaries }),
          },
        }
      : {}),
    onResult: (result) => {
      if (result.status === "failed" || result.status === "timed-out") {
        process.stderr.write(`  ✗ ${result.title}\n`);
      }
    },
  };

  // SIGINT/SIGTERM become an AbortSignal the runner honours: the in-flight
  // test is interrupted, its session still gets a bounded teardown, the
  // remaining tests are reported blocked, and report.json is written before
  // exit. A second signal exits immediately — the first one already asked
  // for the safe path.
  const interrupt = new AbortController();
  let interruptCount = 0;
  const onInterrupt = (): void => {
    interruptCount += 1;
    if (interruptCount > 1) {
      process.exit(130);
    }
    interrupt.abort();
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  let summary;
  try {
    summary = await run({ ...runOptions, signal: interrupt.signal });
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
  process.stdout.write(`${formatRun(summary)}\n`);
  // 130 is the conventional "killed by SIGINT" status; the report already
  // records which test was interrupted and which were blocked.
  return interrupt.signal.aborted ? 130 : exitCodeFor(summary);
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
