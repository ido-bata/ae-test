/**
 * Project configuration and spec discovery.
 *
 * A consumer project can carry one `ae-test.config.json` at its root instead of
 * repeating the same flags on every invocation. The file is JSON on purpose:
 * it loads under plain Node on every supported platform with no TypeScript
 * loader and no dependency, and `AeTestConfig` is the typed contract.
 *
 * Precedence is per option: CLI flag > config file > built-in default. Paths
 * inside the config are relative to the config file's own directory, so a
 * `--config` pointing elsewhere still resolves against the project it
 * describes.
 */

import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const CONFIG_FILE_NAME = "ae-test.config.json";

/**
 * Spec patterns used when neither positional files, `--spec`, nor
 * `config.specs` select anything. `.spec.` is the convention; `.test.` files
 * are deliberately not picked up — they are this repository's own harness
 * tests, not a consumer's suite.
 */
export const DEFAULT_SPEC_PATTERNS: readonly string[] = [
  "**/*.spec.ts",
  "**/*.spec.js",
  "**/*.spec.mjs",
];

export type AeTestHost = "real" | "fake";

export type AeTestConfig = {
  /** Glob patterns selecting spec files, relative to the config file. */
  readonly specs?: readonly string[];
  readonly projectsDir?: string;
  readonly resultsDir?: string;
  readonly baselineDir?: string;
  readonly timeoutMs?: number;
  readonly grep?: string;
  readonly capabilities?: readonly string[];
  /**
   * Which host the suite runs against. There is no implicit fake: absent
   * means "real", exactly like the CLI without `--fake-host`.
   */
  readonly host?: AeTestHost;
  readonly hostScript?: string;
  readonly installDir?: string;
  readonly hostEnvironment?: Readonly<Record<string, string>>;
};

export type LoadedConfig = {
  /** Absolute path of the file that was loaded. */
  readonly path: string;
  /** Directory the config's relative paths resolve against. */
  readonly dir: string;
  readonly config: AeTestConfig;
};

/** A config file that cannot be used. Always a setup error (exit 2). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The config file in `cwd`, when the project has one. */
export function findConfigFile(cwd: string = process.cwd()): string | undefined {
  const candidate = resolve(cwd, CONFIG_FILE_NAME);
  return existsSync(candidate) ? candidate : undefined;
}

/** Reads and validates a config file. Throws ConfigError on any problem. */
export function loadConfigFile(path: string): LoadedConfig {
  const absolute = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(absolute, "utf-8");
  } catch (error) {
    throw new ConfigError(
      `cannot read config ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `config ${absolute} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { path: absolute, dir: dirname(absolute), config: validateConfig(parsed, absolute) };
}

const KNOWN_KEYS = new Set([
  "specs",
  "projectsDir",
  "resultsDir",
  "baselineDir",
  "timeoutMs",
  "grep",
  "capabilities",
  "host",
  "hostScript",
  "installDir",
  "hostEnvironment",
]);

function validateConfig(raw: unknown, path: string): AeTestConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`config ${path} must contain a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new ConfigError(
        `config ${path} has unknown key "${key}". ` +
          `Known keys: ${[...KNOWN_KEYS].sort().join(", ")}`,
      );
    }
  }

  const config: { -readonly [K in keyof AeTestConfig]?: AeTestConfig[K] | undefined } = {};
  const set = <K extends keyof AeTestConfig>(key: K, value: AeTestConfig[K] | undefined): void => {
    if (value !== undefined) {
      config[key] = value;
    }
  };

  set("specs", stringList(record.specs, "specs", path));
  set("capabilities", stringList(record.capabilities, "capabilities", path));
  set("projectsDir", stringValue(record.projectsDir, "projectsDir", path));
  set("resultsDir", stringValue(record.resultsDir, "resultsDir", path));
  set("baselineDir", stringValue(record.baselineDir, "baselineDir", path));
  set("grep", stringValue(record.grep, "grep", path));
  set("hostScript", stringValue(record.hostScript, "hostScript", path));
  set("installDir", stringValue(record.installDir, "installDir", path));

  if (record.timeoutMs !== undefined) {
    if (
      typeof record.timeoutMs !== "number" ||
      !Number.isFinite(record.timeoutMs) ||
      record.timeoutMs <= 0
    ) {
      throw new ConfigError(`config ${path}: "timeoutMs" must be a positive number`);
    }
    config.timeoutMs = record.timeoutMs;
  }

  if (record.host !== undefined) {
    if (record.host !== "real" && record.host !== "fake") {
      throw new ConfigError(`config ${path}: "host" must be "real" or "fake"`);
    }
    config.host = record.host;
  }

  if (record.hostEnvironment !== undefined) {
    const env = record.hostEnvironment;
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      throw new ConfigError(`config ${path}: "hostEnvironment" must be an object of strings`);
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value !== "string") {
        throw new ConfigError(
          `config ${path}: "hostEnvironment.${key}" must be a string, received ${typeof value}`,
        );
      }
      out[key] = value;
    }
    config.hostEnvironment = out;
  }

  // `set` only assigns defined values, so the result satisfies AeTestConfig;
  // the wider property types above are what let the assignments typecheck.
  return config as AeTestConfig;
}

function stringValue(value: unknown, key: string, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`config ${path}: "${key}" must be a non-empty string`);
  }
  return value;
}

function stringList(value: unknown, key: string, path: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new ConfigError(`config ${path}: "${key}" must be a list of non-empty strings`);
  }
  return value as readonly string[];
}

/**
 * Expands spec patterns into absolute spec file paths.
 *
 * `baseDir` is the directory the patterns are relative to — the config file's
 * directory for `config.specs`, the working directory for `--spec` and the
 * defaults. Results are sorted and deduplicated so the run order does not
 * depend on filesystem enumeration order. `node_modules` and dot-directories
 * are never descended into.
 */
export function discoverSpecs(patterns: readonly string[], baseDir: string): string[] {
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of globSync(pattern, { cwd: baseDir })) {
      // The match is relative to baseDir, so its segments — not the absolute
      // path's — decide whether it sits under node_modules or a dot-directory.
      const segments = match.split(/[\\/]+/);
      if (segments.some((segment) => segment === "node_modules" || segment.startsWith("."))) {
        continue;
      }
      const absolute = resolve(baseDir, match);
      try {
        if (statSync(absolute).isFile()) {
          found.add(absolute);
        }
      } catch {
        // A match that vanished between glob and stat is not a spec.
      }
    }
  }
  return [...found].sort();
}
