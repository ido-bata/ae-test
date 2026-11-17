/**
 * Test registration.
 *
 * Deliberately small: tests are declared as a side effect of importing a file,
 * and the runner imports the files and then reads the registry. No globbing,
 * no config file, no watcher — those are the CLI's problem, not the core's.
 */

import { relative } from "node:path";

import type { ConformanceExpectation, TestDeclaration, TestFn } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 60_000;

let sequence = 0;
const registry: TestDeclaration[] = [];
let currentFile = "<unknown>";

/** Called by the runner before importing a file, so declarations know their origin. */
export function setDeclaringFile(file: string): void {
  currentFile = file;
}

export function projectRelative(file: string): string {
  const rel = relative(process.cwd(), file);
  return rel.startsWith("..") ? file : rel;
}

export type TestOptions = {
  /**
   * Millisecond budget for the test body — the fixture's After Effects
   * work. Session launch and teardown have their own bounds and are not
   * covered by this value.
   */
  readonly timeoutMs?: number;
  readonly skip?: boolean;
  /** Capability IDs this test is conformance evidence for. */
  readonly capabilities?: readonly string[];
  /** The strongest conformance claim this test is allowed to make. */
  readonly conformance?: ConformanceExpectation;
};

const CONFORMANCE_EXPECTATIONS: readonly ConformanceExpectation[] = [
  "pass",
  "unsupported",
  "refused",
  "unknown",
];

export function test(title: string, fn: TestFn, options: TestOptions = {}): void {
  if (typeof title !== "string" || title.length === 0) {
    throw new TypeError("test title must be a non-empty string");
  }
  if (typeof fn !== "function") {
    throw new TypeError(`test "${title}" needs a function`);
  }
  const capabilities = options.capabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new TypeError(`test "${title}" capabilities must be non-empty strings`);
  }
  if (
    options.conformance !== undefined &&
    !CONFORMANCE_EXPECTATIONS.includes(options.conformance)
  ) {
    throw new TypeError(
      `test "${title}" conformance must be one of ${CONFORMANCE_EXPECTATIONS.join(", ")}`,
    );
  }
  sequence += 1;
  registry.push({
    id: `${slug(projectRelative(currentFile))}#${sequence}`,
    title,
    file: projectRelative(currentFile),
    fn,
    timeoutMs: options.timeoutMs,
    skip: options.skip ?? false,
    capabilities,
    ...(options.conformance === undefined ? {} : { conformance: options.conformance }),
  });
}

export function skip(title: string, _fn: TestFn, options: TestOptions = {}): void {
  test(title, _fn, { ...options, skip: true });
}

export function registeredTests(): readonly TestDeclaration[] {
  return registry;
}

export function clearRegistry(): void {
  registry.length = 0;
  sequence = 0;
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}
