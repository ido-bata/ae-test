/**
 * The runner: provision, run, judge, collect.
 *
 * One After Effects session per test. That is the conservative default: AE is
 * a single-instance application, so parallel sessions are not possible anyway,
 * and a fresh project per test keeps one test's state out of the next one's
 * result. Concurrency is a later question, and the right answer will involve
 * the worker boundary in `ae-farm`, not this loop.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AfterEffects, HostTransport } from "@ido-bata/ae-a8n";

import { expect, expectFrame } from "./expect.js";
import { TestFixture, type FixtureOptions } from "./fixture.js";
import { DEFAULT_TIMEOUT_MS, clearRegistry, setDeclaringFile } from "./registry.js";
import { SnapshotStore } from "./snapshot.js";
import type {
  Artifact,
  RunSummary,
  TestContext,
  TestDeclaration,
  TestFailure,
  TestResult,
  TestStatus,
} from "./types.js";

export const DEFAULT_RESULTS_DIR = ".ae-test-results";

export type RunOptions = {
  /** Test files to import. */
  readonly files: readonly string[];
  /** Root for artifacts, traces, reports, and snapshots. */
  readonly resultsDir?: string;
  /** Directory holding `.aep` project fixtures. */
  readonly projectsDir?: string;
  /** Per-test timeout, overridable per test. */
  readonly timeoutMs?: number;
  /** Record snapshot baselines instead of comparing. */
  readonly updateSnapshots?: boolean;
  /** Substring filter over test titles. */
  readonly grep?: string;
  /** Transport for every session; omit to use a real After Effects. */
  readonly transport?: HostTransport;
  /** Called after each test, for progress output. */
  readonly onResult?: (result: TestResult) => void;
};

/** A test that exceeded its budget. The session is torn down regardless. */
class TestTimeoutError extends Error {
  constructor(title: string, timeoutMs: number) {
    super(`test "${title}" exceeded its ${timeoutMs}ms budget`);
    this.name = "TestTimeoutError";
  }
}

let loadGeneration = 0;

/**
 * Imports each test file so its `test()` calls register.
 *
 * The module id carries a generation counter. ESM caches by URL, so without it
 * a second `run()` in the same process would import a cached module and find
 * an empty registry — the run would silently execute nothing and report zero
 * tests as a pass.
 */
export async function loadTestFiles(files: readonly string[]): Promise<void> {
  loadGeneration += 1;
  for (const file of files) {
    const absolute = resolve(file);
    setDeclaringFile(absolute);
    await import(`${pathToFileURL(absolute).href}?run=${loadGeneration}`);
  }
}

export async function run(options: RunOptions): Promise<RunSummary> {
  const { registeredTests } = await import("./registry.js");
  const began = Date.now();

  const resultsDir = resolve(options.resultsDir ?? DEFAULT_RESULTS_DIR);
  const snapshotsDir = join(resultsDir, "__snapshots__");
  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(snapshotsDir, { recursive: true });

  // A run owns the registry it executes. Without this, a second `run()` in
  // the same process would see the first run's registrations plus its own and
  // report duplicates.
  clearRegistry();
  await loadTestFiles(options.files);

  const declared = registeredTests().filter(
    (candidate) => options.grep === undefined || candidate.title.includes(options.grep),
  );

  const results: TestResult[] = [];
  for (const declaration of declared) {
    const result = await runOne(declaration, {
      resultsDir,
      snapshotsDir,
      updateSnapshots: options.updateSnapshots ?? false,
      ...(options.projectsDir === undefined ? {} : { projectsDir: options.projectsDir }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.transport === undefined ? {} : { transport: options.transport }),
    });
    results.push(result);
    options.onResult?.(result);
  }

  const reportPath = join(resultsDir, "report.json");
  const summary: RunSummary = {
    results,
    durationMs: Date.now() - began,
    resultsDir,
    reportPath,
  };
  writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
  return summary;
}

type OneTestOptions = {
  resultsDir: string;
  snapshotsDir: string;
  projectsDir?: string;
  /** Run-level default budget; a test may override it. */
  timeoutMs?: number;
  transport?: HostTransport;
  updateSnapshots: boolean;
};

async function runOne(
  declaration: TestDeclaration,
  options: OneTestOptions,
): Promise<TestResult> {
  const began = Date.now();
  const outputDir = join(options.resultsDir, declaration.id.replace(/[^a-zA-Z0-9._-]+/g, "-"));

  if (declaration.skip) {
    return {
      id: declaration.id,
      title: declaration.title,
      file: declaration.file,
      status: "skipped",
      durationMs: 0,
      artifacts: [],
    };
  }

  const testInfo = {
    id: declaration.id,
    title: declaration.title,
    file: declaration.file,
    outputDir,
  };

  const fixtureOptions: FixtureOptions = {
    resultsDir: outputDir,
    ...(options.projectsDir === undefined ? {} : { projectsDir: options.projectsDir }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  };
  const fixture = new TestFixture(testInfo, fixtureOptions);
  const snapshots = new SnapshotStore({
    dir: options.snapshotsDir,
    testId: declaration.id.replace(/[^a-zA-Z0-9._-]+/g, "-"),
    update: options.updateSnapshots,
  });

  let session: AfterEffects | undefined;
  let status: TestStatus = "passed";
  let failure: TestFailure | undefined;
  let artifacts: Artifact[] = [];

  try {
    session = await fixture.session();
    const context: TestContext = {
      ae: session,
      fixture: fixture.fixture,
      testInfo,
      expectFrame: (frame) => expectFrame(frame, snapshots),
      expect,
    };
    // A test's own budget wins; otherwise the run's; otherwise the default.
    const budgetMs = declaration.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const body = withTimeout(
      declaration.fn(context),
      budgetMs,
      new TestTimeoutError(declaration.title, budgetMs),
    );
    await body;
  } catch (error) {
    status = error instanceof TestTimeoutError ? "timed-out" : "failed";
    failure = describeFailure(error, session);
  } finally {
    artifacts = fixture.collectArtifacts(session);
    await fixture.teardown();
  }

  return {
    id: declaration.id,
    title: declaration.title,
    file: declaration.file,
    status,
    durationMs: Date.now() - began,
    ...(failure === undefined ? {} : { failure }),
    artifacts,
  };
}

/**
 * Fails a test that outlives its budget.
 *
 * The underlying operation is not cancelled — After Effects does not take a
 * cancel — but the runner stops waiting and proceeds to teardown, so one slow
 * test cannot stall a whole run.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: Error): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(onTimeout instanceof Error ? onTimeout : new Error(String(onTimeout)));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        // A test body can reject with anything; normalise so the runner's
        // failure description has a consistent shape.
        rejectPromise(
          error instanceof Error ? error : new Error(`test rejected with ${String(error)}`),
        );
      },
    );
  });
}

function describeFailure(error: unknown, session: AfterEffects | undefined): TestFailure {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);

  // The last few operations from the ae-a8n trace: enough to say where the
  // run stopped without dumping the whole history into the report.
  const lastOperations =
    session === undefined
      ? []
      : session.traceEvents.slice(-5).map((event) => `${event.op} (${event.status})`);

  const stack = error instanceof Error ? error.stack : undefined;
  return {
    name,
    message,
    ...(stack === undefined ? {} : { stack }),
    lastOperations,
  };
}

export function countByStatus(results: readonly TestResult[]): Record<TestStatus, number> {
  const counts: Record<TestStatus, number> = {
    passed: 0,
    failed: 0,
    "timed-out": 0,
    skipped: 0,
  };
  for (const result of results) {
    counts[result.status] += 1;
  }
  return counts;
}

export function hasFailures(results: readonly TestResult[]): boolean {
  return results.some((result) => result.status === "failed" || result.status === "timed-out");
}
