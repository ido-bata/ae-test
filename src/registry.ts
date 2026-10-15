/**
 * Test registration.
 *
 * Deliberately small: tests are declared as a side effect of importing a file,
 * and the runner imports the files and then reads the registry. No globbing,
 * no config file, no watcher — those are the CLI's problem, not the core's.
 */

import { relative } from "node:path";

import type { TestDeclaration, TestFn } from "./types.js";

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
  /** Millisecond budget for the whole test, including After Effects work. */
  readonly timeoutMs?: number;
  readonly skip?: boolean;
};

export function test(title: string, fn: TestFn, options: TestOptions = {}): void {
  if (typeof title !== "string" || title.length === 0) {
    throw new TypeError("test title must be a non-empty string");
  }
  if (typeof fn !== "function") {
    throw new TypeError(`test "${title}" needs a function`);
  }
  sequence += 1;
  registry.push({
    id: `${slug(projectRelative(currentFile))}#${sequence}`,
    title,
    file: projectRelative(currentFile),
    fn,
    timeoutMs: options.timeoutMs,
    skip: options.skip ?? false,
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
