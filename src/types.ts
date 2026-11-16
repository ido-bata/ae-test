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

/**
 * What a conformance test claims to prove. `pass` is the ordinary case; the
 * others let a spec prove a refusal or an unsupported path without the run
 * reporting it as an ordinary pass.
 */
export type ConformanceExpectation = "pass" | "unsupported" | "refused" | "unknown";

/** How the session was torn down, separately from how the test body went. */
export type CleanupOutcome =
  | { readonly status: "ok"; readonly quit: boolean }
  | { readonly status: "failed"; readonly name: string; readonly message: string };

export type Artifact = {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
  /** How the artifact ended up in the results directory. */
  readonly kind: "render" | "trace" | "attachment" | "diff";
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
  /** Capability IDs this test is evidence for, in ae-devtools catalog grammar. */
  readonly capabilities: readonly string[];
  /** Conformance claim this test is allowed to make. */
  readonly conformance?: ConformanceExpectation;
};

export type TestResultExtras = {
  /** Teardown outcome; absent when no session was opened. */
  readonly cleanup?: CleanupOutcome;
  /** Why a "blocked" test was not run. */
  readonly blockedReason?: string;
};

/** A project fixture this test resolved, and the bytes it had when it did. */
export type FixtureDigest = {
  readonly name: string;
  readonly path: string;
  /** SHA-256 of the file, or null when it could not be read. */
  readonly sha256: string | null;
};

/**
 * What the test actually ran against, recorded per test.
 *
 * `uid` is the uid of the process that ran the test body — inside an isolated
 * session that is the session's own account, so the record says which account
 * saw these results. `asid` is the audit session id of that account's GUI
 * session (`launchctl print gui/<uid>`); null when it could not be read, which
 * is also the answer on any platform other than macOS.
 */
export type SessionFacts = {
  readonly uid: number | null;
  readonly asid: number | null;
  /** The host's own report about itself, from the launch probe. */
  readonly ae: { readonly version: string; readonly build?: string } | null;
  /** Static host methods this project's host script declared. */
  readonly extensions: readonly string[];
  readonly fixtures: readonly FixtureDigest[];
  /**
   * The kind of transport the session ran on: the injected transport's own
   * `kind` (`fake-in-process` is ae-a8n's fake host, `script-invocation` the
   * built-in real-AE transport), or "script-invocation" when no transport
   * was injected. Absent or null means provenance could not be proven —
   * never treat it as real.
   */
  readonly transport?: string | null;
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
  /**
   * Set when the session was refused because this run did not start its host:
   * "attached" when an After Effects was already running, "unknown" when
   * ownership could not be decided. The distinction is the reader's, so it is
   * structured rather than left inside the message.
   */
  readonly ownership?: {
    readonly kind: "attached" | "unknown";
    readonly evidence: string;
    /**
     * What the refusal-time close reported, when it answered. On "unknown"
     * ownership `quit: false` means an After Effects may still be running.
     */
    readonly quit?: boolean;
    readonly quitReason?: string;
    /** Set when the refusal-time close itself threw; quit/quitReason are then absent. */
    readonly closeError?: string;
  };
};

export type TestResult = {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  readonly status: TestStatus;
  readonly durationMs: number;
  readonly failure?: TestFailure;
  readonly artifacts: readonly Artifact[];
  /** Absent when no session was opened. */
  readonly session?: SessionFacts;
  /** Capability IDs this result is evidence for. */
  readonly capabilities: readonly string[];
  /** Conformance claim this test was allowed to make. */
  readonly conformance?: ConformanceExpectation;
} & TestResultExtras;

export type RunSummary = {
  /** Schema version of this report shape; see docs/api.md. */
  readonly schema: "ae-test.report/v1";
  readonly results: readonly TestResult[];
  readonly durationMs: number;
  readonly resultsDir: string;
  readonly reportPath: string;
  /** Present when the run was asked for conformance evidence. */
  readonly conformancePath?: string;
  /** `conformance.json`'s own ok flag, when conformance evidence was written. */
  readonly conformanceOk?: boolean;
  /** True when filters (or empty spec files) selected zero tests to run. */
  readonly noTestsSelected?: boolean;
};

export type { RenderedFrame, TraceEvent };
