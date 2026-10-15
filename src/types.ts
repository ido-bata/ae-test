/**
 * Types the test author sees.
 *
 * `TestContext` is deliberately shaped like a Playwright fixture object: one
 * argument, destructured at the call site, no global state to import.
 */

import type { AfterEffects, RenderedFrame, TraceEvent } from "@ido-bata/ae-a8n";

import type { AsyncExpectation, Expectation, RenderedFrameExpectation } from "./expect.js";

/**
 * "blocked": the test was not run, because an earlier test left After
 * Effects in a state nobody can vouch for. Not a pass, and not a failure of
 * this test's own code.
 */
export type TestStatus = "passed" | "failed" | "timed-out" | "skipped" | "blocked";

/** How the session was torn down, separately from how the test body went. */
export type CleanupOutcome =
  | { readonly status: "ok"; readonly quit: boolean }
  | { readonly status: "failed"; readonly name: string; readonly message: string };

export type Artifact = {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
  /** How the artifact ended up in the results directory. */
  readonly kind: "render" | "trace" | "attachment";
};

export type TestInfo = {
  readonly id: string;
  readonly title: string;
  /** File the test was declared in, relative to the project root. */
  readonly file: string;
  /** Per-test output directory. Everything a test produces lands here. */
  readonly outputDir: string;
};

export type Fixture = {
  /** Absolute path to a project fixture, by name. */
  project(name: string): string;
  /** Directory holding project fixtures. */
  readonly projectsDir: string;
  /** Write a file into this test's output directory and get an artifact back. */
  attach(name: string, contents: string | Uint8Array): Promise<Artifact>;
};

export type TestContext = {
  /** A live After Effects session, launched and torn down per test. */
  readonly ae: AfterEffects;
  readonly fixture: Fixture;
  readonly testInfo: TestInfo;
  /**
   * Frame assertions, bound to this test's snapshot namespace. Passed in
   * rather than imported so a test file has no ambient state to configure.
   */
  expectFrame(frame: RenderedFrame): RenderedFrameExpectation;
  /**
   * Assertions, provided per test like every other fixture. Taking it from the
   * context rather than importing it keeps a spec free of module-level state,
   * which is what lets two runs in one process stay independent.
   */
  expect<T>(actual: Promise<T>): AsyncExpectation<T>;
  expect<T>(actual: T): Expectation<T>;
};

export type TestFn = (context: TestContext) => Promise<void>;

export type TestDeclaration = {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  readonly fn: TestFn;
  /** Undefined means "use the run's budget"; the runner resolves it. */
  readonly timeoutMs: number | undefined;
  /** Resolved lazily so `test.skip` and focus filters work. */
  readonly skip: boolean;
};

export type TestResultExtras = {
  /** Teardown outcome; absent when no session was opened. */
  readonly cleanup?: CleanupOutcome;
  /** Why a "blocked" test was not run. */
  readonly blockedReason?: string;
};

export type TestFailure = {
  readonly name: string;
  readonly message: string;
  /** Stack when one is available. */
  readonly stack?: string;
  /** Operations immediately before the failure, from the ae-a8n trace. */
  readonly lastOperations: readonly string[];
  /** Where it failed: starting the session, the test body, or teardown. */
  readonly phase?: "launch" | "body" | "cleanup";
};

export type TestResult = {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  readonly status: TestStatus;
  readonly durationMs: number;
  readonly failure?: TestFailure;
  readonly artifacts: readonly Artifact[];
} & TestResultExtras;

export type RunSummary = {
  readonly results: readonly TestResult[];
  readonly durationMs: number;
  readonly resultsDir: string;
  readonly reportPath: string;
};

export type { RenderedFrame, TraceEvent };
