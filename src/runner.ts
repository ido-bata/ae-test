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
import {
  environmentBlockReason,
  loadCapabilityCatalog,
  writeConformanceReport,
  type CapabilityCatalogIndex,
  type ConformanceRunOptions,
} from "./conformance.js";
import {
  HostNotOwnedError,
  TestContextRevokedError,
  TestFixture,
  type FixtureOptions,
} from "./fixture.js";
import { DEFAULT_TIMEOUT_MS, clearRegistry, projectRelative, setDeclaringFile } from "./registry.js";
import { SnapshotStore } from "./snapshot.js";
import type {
  Artifact,
  CleanupOutcome,
  RunSummary,
  SessionFacts,
  TestContext,
  TestDeclaration,
  TestFailure,
  TestResult,
  TestStatus,
} from "./types.js";

export const DEFAULT_RESULTS_DIR = ".ae-test-results";

/**
 * Where snapshot baselines live by default: a directory meant to be committed,
 * unlike the results directory. The runner groups baselines into per-
 * environment subdirectories underneath it (see `snapshotEnvironmentKey`).
 */
export const DEFAULT_BASELINE_DIR = "__snapshots__";

/** ae-a8n's in-process fake host; its kind is the one stable identifier it has. */
const FAKE_TRANSPORT_KIND = "fake-in-process";

export type RunOptions = {
  /** Test files to import. */
  readonly files: readonly string[];
  /** Root for artifacts, traces, and reports. */
  readonly resultsDir?: string;
  /**
   * Directory holding snapshot baselines, meant to be committed to the
   * project. Defaults to `__snapshots__` under the current directory. Baselines
   * are grouped per environment (transport, OS/arch, After Effects version)
   * so a baseline recorded against the fake host or another AE version is
   * never compared against this run's renders. Normally read-only;
   * `--update-snapshots` rewrites only this directory.
   */
  readonly baselineDir?: string;
  /** Directory holding `.aep` project fixtures. */
  readonly projectsDir?: string;
  /** Per-test timeout, overridable per test. */
  readonly timeoutMs?: number;
  /** Record snapshot baselines instead of comparing. */
  readonly updateSnapshots?: boolean;
  /** Substring filter over test titles. */
  readonly grep?: string;
  /** Only run tests declaring at least one of these capability IDs. */
  readonly capabilityFilter?: readonly string[];
  /** Transport for every session; omit to use a real After Effects. */
  readonly transport?: HostTransport;
  /** Host script with this project's static extension methods, if any. */
  readonly hostScript?: string;
  /** Explicit After Effects installation; omit to discover one. */
  readonly installDir?: string;
  /** Variables set inside the After Effects process before anything else runs. */
  readonly hostEnvironment?: Readonly<Record<string, string>>;
  /** Called after each test, for progress output. */
  readonly onResult?: (result: TestResult) => void;
  /**
   * Aborts the run: the in-flight test is interrupted (its body is not
   * cancelled — After Effects does not take one — but the runner stops
   * waiting, tears the session down within budget, and blocks the rest).
   * The CLI wires this to SIGINT/SIGTERM.
   */
  readonly signal?: AbortSignal;
  /**
   * How long teardown may wait for `session.close()` before the cleanup
   * is reported as timed out. Defaults to the per-operation timeout plus
   * a margin, so a legitimately slow quit is never cut short.
   */
  readonly teardownTimeoutMs?: number;
  /**
   * How long a timed-out or interrupted body is given to settle before
   * teardown begins. Defaults to 5000.
   */
  readonly drainTimeoutMs?: number;
  /** Write ae-devtools-schema conformance evidence for this run. */
  readonly conformance?: ConformanceRunOptions;
};

/**
 * The baseline namespace for one run's environment.
 *
 * A real host renders through the OS and an After Effects version, so its
 * baselines are keyed by transport kind, platform/arch and the host's own
 * version — a baseline recorded on macOS AE 26.x must not be compared on
 * Windows or another AE version. The in-process fake renders identically
 * everywhere by construction, so keying it by OS would only fragment
 * baselines; its kind alone is the namespace.
 */
function snapshotEnvironmentKey(
  transport: HostTransport | undefined,
  session: AfterEffects,
): string {
  const kind =
    transport === undefined
      ? "script-invocation"
      : typeof transport.kind === "string" && transport.kind.length > 0
        ? transport.kind
        : "unknown-transport";
  const parts = [kind];
  if (kind !== FAKE_TRANSPORT_KIND) {
    parts.push(process.platform, process.arch);
    const ae = hostVersion(session);
    if (ae !== null) {
      parts.push(`ae-${ae.version}${ae.build === undefined ? "" : `-${ae.build}`}`);
    }
  }
  return parts.join("-").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function hostVersion(session: AfterEffects): { version: string; build?: string } | null {
  try {
    const info = session.info();
    return {
      version: info.version,
      ...(info.build === undefined ? {} : { build: info.build }),
    };
  } catch {
    return null;
  }
}

/** A test that exceeded its budget. The session is torn down regardless. */
class TestTimeoutError extends Error {
  constructor(title: string, timeoutMs: number) {
    super(`test "${title}" exceeded its ${timeoutMs}ms budget`);
    this.name = "TestTimeoutError";
  }
}

/** The run was asked to stop (SIGINT/SIGTERM, or an aborted signal) mid-test. */
class RunInterruptedError extends Error {
  constructor(phase: "launch" | "body" | "") {
    super(
      phase === ""
        ? "the run was interrupted"
        : `the run was interrupted during ${phase === "launch" ? "session launch" : "the test body"}`,
    );
    this.name = "RunInterruptedError";
  }
}

/**
 * How long a timed-out or interrupted body is given to settle before
 * teardown begins. The wait exists so operations already in flight can
 * land in the trace and so a body that was about to finish does not race
 * its own session's close; it is deliberately short — the budget is
 * already spent, and teardown must not be held hostage by a body that
 * will never settle.
 */
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Slack added to the per-operation timeout when no explicit teardown
 * budget is configured: ae-a8n bounds a quit by the same per-operation
 * timeout the session launched with, so the wait has to outlast that
 * bound before it can mean "the close itself is stuck".
 */
const TEARDOWN_MARGIN_MS = 30_000;
const MIN_TEARDOWN_TIMEOUT_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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

type SpecLoadError = {
  readonly file: string;
  readonly error: unknown;
};

/**
 * Imports each spec file, collecting per-file failures instead of throwing.
 *
 * `run()` uses this so one broken spec cannot take the whole suite's
 * evidence down with it; the exported `loadTestFiles` keeps its
 * fail-fast contract for programmatic callers. An aborted signal stops
 * the remaining imports — there is nothing left to run them for.
 */
async function loadSpecsIsolated(
  files: readonly string[],
  signal: AbortSignal | undefined,
): Promise<SpecLoadError[]> {
  loadGeneration += 1;
  const errors: SpecLoadError[] = [];
  for (const file of files) {
    if (signal?.aborted === true) {
      break;
    }
    const absolute = resolve(file);
    setDeclaringFile(absolute);
    try {
      await import(`${pathToFileURL(absolute).href}?run=${loadGeneration}`);
    } catch (error) {
      errors.push({ file: absolute, error });
    }
  }
  return errors;
}

/** A spec that never registered a test still gets a result in the report. */
function specLoadResult({ file, error }: SpecLoadError, index: number): TestResult {
  const relative = projectRelative(file);
  const slug = relative
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return {
    id: `${slug}#load-${index}`,
    title: relative,
    file: relative,
    status: "failed",
    durationMs: 0,
    artifacts: [],
    capabilities: [],
    failure: {
      name: error instanceof Error ? error.name : typeof error,
      message:
        `spec file failed to load: ${error instanceof Error ? error.message : String(error)}`,
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
      lastOperations: [],
      phase: "load",
    },
  };
}

export async function run(options: RunOptions): Promise<RunSummary> {
  const { registeredTests } = await import("./registry.js");
  const began = Date.now();

  const resultsDir = resolve(options.resultsDir ?? DEFAULT_RESULTS_DIR);
  const reportPath = join(resultsDir, "report.json");
  // Pre-0.2 baselines lived inside the results directory. They are still read
  // as a fallback so an existing suite keeps working until its baselines are
  // re-recorded or moved; nothing is written there any more.
  const legacySnapshotsDir = join(resultsDir, "__snapshots__");
  const baselineRoot = resolve(options.baselineDir ?? DEFAULT_BASELINE_DIR);
  mkdirSync(resultsDir, { recursive: true });

  // A bad catalog is a setup error: fail before any test launches a session.
  const conformanceCatalog: CapabilityCatalogIndex | undefined =
    options.conformance?.catalogPath === undefined
      ? undefined
      : loadCapabilityCatalog(options.conformance.catalogPath);

  // A run owns the registry it executes. Without this, a second `run()` in
  // the same process would see the first run's registrations plus its own and
  // report duplicates.
  clearRegistry();
  // A spec that fails to import is that file's failure, not the whole run's:
  // the remaining files still load and execute, and the report keeps the
  // load error next to the results it did produce.
  const loadErrors = await loadSpecsIsolated(options.files, options.signal);

  const capabilityFilter = options.capabilityFilter;
  const declared = registeredTests().filter(
    (candidate) =>
      (options.grep === undefined || candidate.title.includes(options.grep)) &&
      (capabilityFilter === undefined ||
        candidate.capabilities.some((id) => capabilityFilter.includes(id))),
  );

  // report.json is rewritten after every result, so a crash mid-run still
  // leaves the evidence collected so far. `partial` marks those snapshots;
  // the final write below drops it.
  const results: TestResult[] = [];
  const persistReport = (): void => {
    writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          schema: "ae-test.report/v1",
          results,
          durationMs: Date.now() - began,
          resultsDir,
          reportPath,
          partial: true,
          ...(declared.length === 0 ? { noTestsSelected: true } : {}),
        } satisfies RunSummary,
        null,
        2,
      )}\n`,
      "utf-8",
    );
  };
  for (const [index, loadError] of loadErrors.entries()) {
    const failed = specLoadResult(loadError, index);
    results.push(failed);
    persistReport();
    options.onResult?.(failed);
  }
  persistReport();
  // Set once a test leaves After Effects in a state nobody can vouch for: a
  // teardown that failed, a launch that failed, an AE this run does not own.
  // Every later test is then reported as blocked instead of being run against
  // that host — a stuck AE would fail it for reasons that are not its own, or
  // worse, let it pass against the wrong state.
  let hostUnknown: string | undefined;
  for (const declaration of declared) {
    // A catalog can declare a capability unsupported on this OS/arch. When
    // every capability the test claims is incompatible here, running it
    // would only manufacture a failure (or worse, a pass) against an
    // environment the catalog says cannot work — report it blocked instead.
    const environmentBlock =
      conformanceCatalog === undefined || declaration.skip
        ? undefined
        : environmentBlockReason(declaration.capabilities, conformanceCatalog, {
            os: process.platform,
            arch: process.arch,
          });
    const blockReason =
      environmentBlock ??
      (hostUnknown !== undefined && !declaration.skip ? hostUnknown : undefined) ??
      (options.signal?.aborted === true && !declaration.skip
        ? "the run was interrupted before this test started"
        : undefined);
    if (blockReason !== undefined) {
      const blocked = blockedResult(declaration, blockReason);
      results.push(blocked);
      persistReport();
      options.onResult?.(blocked);
      continue;
    }
    const result = await runOne(declaration, {
      resultsDir,
      baselineRoot,
      legacySnapshotsDir,
      updateSnapshots: options.updateSnapshots ?? false,
      signal: options.signal,
      teardownTimeoutMs: options.teardownTimeoutMs,
      drainTimeoutMs: options.drainTimeoutMs,
      timeoutMs: options.timeoutMs,
      ...(options.projectsDir === undefined ? {} : { projectsDir: options.projectsDir }),
      ...(options.transport === undefined ? {} : { transport: options.transport }),
      ...(options.hostScript === undefined ? {} : { hostScript: options.hostScript }),
      ...(options.installDir === undefined ? {} : { installDir: options.installDir }),
      ...(options.hostEnvironment === undefined
        ? {}
        : { hostEnvironment: options.hostEnvironment }),
    });
    results.push(result);
    persistReport();
    options.onResult?.(result);
    if (result.cleanup?.status === "failed") {
      hostUnknown = `"${result.title}" did not clean up: ${result.cleanup.name}: ${result.cleanup.message}`;
    } else if (result.failure?.phase === "launch" && result.status !== "interrupted") {
      // An interrupted launch is not evidence the host is untrustworthy:
      // the session that did arrive was torn down normally.
      hostUnknown = `"${result.title}" could not start a session: ${result.failure.name}: ${result.failure.message}`;
    }
  }

  const baseSummary: RunSummary = {
    schema: "ae-test.report/v1",
    results,
    durationMs: Date.now() - began,
    resultsDir,
    reportPath,
    // Filters that matched nothing must not read as a green run.
    ...(declared.length === 0 ? { noTestsSelected: true } : {}),
  };
  const conformance =
    options.conformance === undefined
      ? undefined
      : writeConformanceReport(baseSummary, options.conformance, conformanceCatalog);
  const summary: RunSummary = {
    ...baseSummary,
    ...(conformance === undefined
      ? {}
      : { conformancePath: conformance.path, conformanceOk: conformance.report.ok }),
  };
  writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
  return summary;
}

/** A test kept out of the run, with the reason it was kept out. */
function blockedResult(declaration: TestDeclaration, reason: string): TestResult {
  return {
    id: declaration.id,
    title: declaration.title,
    file: declaration.file,
    status: "blocked",
    durationMs: 0,
    artifacts: [],
    blockedReason: reason,
    capabilities: declaration.capabilities,
    ...(declaration.conformance === undefined ? {} : { conformance: declaration.conformance }),
  };
}

type OneTestOptions = {
  resultsDir: string;
  /** Root of the committed baseline tree; per-environment dirs live under it. */
  baselineRoot: string;
  /** Pre-0.2 baseline location, read-only fallback. */
  legacySnapshotsDir: string;
  projectsDir?: string;
  /** Run-level default budget; a test may override it. */
  timeoutMs?: number | undefined;
  /** Aborts the in-flight wait; the session is still torn down. */
  signal?: AbortSignal | undefined;
  teardownTimeoutMs?: number | undefined;
  drainTimeoutMs?: number | undefined;
  transport?: HostTransport;
  hostScript?: string;
  installDir?: string;
  hostEnvironment?: Readonly<Record<string, string>>;
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
      capabilities: declaration.capabilities,
      ...(declaration.conformance === undefined
        ? {}
        : { conformance: declaration.conformance }),
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
    ...(options.hostScript === undefined ? {} : { hostScript: options.hostScript }),
    ...(options.installDir === undefined ? {} : { installDir: options.installDir }),
    ...(options.hostEnvironment === undefined
      ? {}
      : { hostEnvironment: options.hostEnvironment }),
  };
  const fixture = new TestFixture(testInfo, fixtureOptions);
  const testId = declaration.id.replace(/[^a-zA-Z0-9._-]+/g, "-");

  let session: AfterEffects | undefined;
  let status: TestStatus = "passed";
  let failure: TestFailure | undefined;
  let artifacts: Artifact[] = [];
  let cleanup: CleanupOutcome | undefined;
  let sessionFacts: SessionFacts | undefined;
  let snapshots: SnapshotStore | undefined;
  let launched = false;
  let bodyStarted = false;
  let bodySettled = true;

  try {
    // An abort that landed between the scheduler's check and here must not
    // pay for a launch it will only tear down.
    if (options.signal?.aborted === true) {
      throw new RunInterruptedError("");
    }
    session = await launchSession(fixture, options.signal);
    launched = true;
    // The baseline directory is environment-scoped, and the environment is
    // only fully known once the session is up: the transport kind up front,
    // the host's own version from the launch probe.
    snapshots = new SnapshotStore({
      dir: join(options.baselineRoot, snapshotEnvironmentKey(options.transport, session)),
      legacyDir: options.legacySnapshotsDir,
      testId,
      update: options.updateSnapshots,
      artifactDir: outputDir,
    });
    const snapshotStore = snapshots;
    const context: TestContext = {
      ae: guardSession(session, () => fixture.revoked),
      fixture: fixture.fixture,
      testInfo,
      expectFrame: (frame) => {
        if (fixture.revoked) {
          throw new TestContextRevokedError();
        }
        return expectFrame(frame, snapshotStore);
      },
      expect,
    };
    // A test's own budget wins; otherwise the run's; otherwise the default.
    // The budget covers the test body only: launch and teardown have their
    // own bounds (ae-a8n's transport timeouts, teardownTimeoutMs).
    const budgetMs = declaration.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    bodyStarted = true;
    bodySettled = false;
    const body = Promise.resolve()
      .then(() => declaration.fn(context))
      .then(
        (value) => {
          bodySettled = true;
          return value;
        },
        (error: unknown) => {
          bodySettled = true;
          throw error;
        },
      );
    await withBudget(body, budgetMs, declaration.title, options.signal);
  } catch (error) {
    // The runner has stopped attributing work to this test: whatever the
    // body still holds is revoked before the drain wait, so nothing new
    // leaves through its handles while settlement is observed.
    fixture.revoke();
    status =
      error instanceof TestTimeoutError
        ? "timed-out"
        : error instanceof RunInterruptedError
          ? "interrupted"
          : "failed";
    failure = { ...describeFailure(error, session), phase: launched ? "body" : "launch" };
    // A body that outlived its budget keeps running — it cannot be
    // cancelled — so give it a bounded moment to settle before teardown
    // races its last operations, and record it when it does not.
    if (
      bodyStarted &&
      !bodySettled &&
      (error instanceof TestTimeoutError || error instanceof RunInterruptedError)
    ) {
      const drainMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
      const deadline = Date.now() + drainMs;
      while (!bodySettled && Date.now() < deadline) {
        await delay(Math.min(50, Math.max(deadline - Date.now(), 1)));
      }
      if (!bodySettled) {
        failure = { ...failure, bodyStillRunning: true };
      }
    }
  } finally {
    // Every exit path ends the test's context — a settled body, a timed-out
    // one, a failed launch — before artifacts are read and teardown begins.
    // Idempotent with the revoke in the catch above.
    fixture.revoke();
    artifacts = [
      ...fixture.collectArtifacts(session),
      ...(snapshots?.artifacts ?? []),
    ];
    // Read before teardown: version, extension methods and the session's own
    // identity are facts about the session that was used, and they disappear
    // with it. Every read inside is guarded, so a fact nobody can measure is
    // recorded as absent rather than replacing the test's own result.
    sessionFacts = fixture.sessionFacts(session);
    cleanup = await boundedTeardown(fixture, options);
  }

  // A body that passed does not make the test pass if the session could not
  // be torn down: the result has to cover everything the test did.
  if (status === "passed" && cleanup?.status === "failed") {
    status = "failed";
    failure = {
      name: "CleanupError",
      message: `the test body passed, but teardown failed: ${cleanup.name}: ${cleanup.message}`,
      lastOperations:
        session === undefined
          ? []
          : session.traceEvents.slice(-5).map((event) => `${event.op} (${event.status})`),
      phase: "cleanup",
    };
  }

  return {
    id: declaration.id,
    title: declaration.title,
    file: declaration.file,
    status,
    durationMs: Date.now() - began,
    ...(failure === undefined ? {} : { failure }),
    ...(cleanup === undefined ? {} : { cleanup }),
    ...(sessionFacts === undefined ? {} : { session: sessionFacts }),
    artifacts,
    capabilities: declaration.capabilities,
    ...(declaration.conformance === undefined
      ? {}
      : { conformance: declaration.conformance }),
  };
}

/**
 * The session as the test body may see it.
 *
 * `AfterEffects` keeps its state in private fields, so the guard cannot
 * subclass or re-wrap its methods — it proxies property access instead and
 * binds every function back to the real instance. While the test is live the
 * proxy is transparent; once `isRevoked` reports the test's terminal state,
 * any further use throws `TestContextRevokedError` before a call can be
 * dispatched. Symbol-keyed access (inspection, `Symbol.asyncDispose`) still
 * reaches the target: it cannot start new host work.
 */
function guardSession(
  session: AfterEffects,
  isRevoked: () => boolean,
): AfterEffects {
  return new Proxy(session, {
    get(target, property) {
      if (typeof property === "string" && isRevoked()) {
        throw new TestContextRevokedError();
      }
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      const callable = value as (this: unknown, ...args: unknown[]) => unknown;
      return callable.bind(target);
    },
    set(target, property, value) {
      if (typeof property === "string" && isRevoked()) {
        throw new TestContextRevokedError();
      }
      return Reflect.set(target, property, value);
    },
  });
}

/**
 * Waits for the session launch, unless the run is interrupted first.
 *
 * A launch cannot be cancelled either, so an abort does not drop it: the
 * launch is still awaited to settlement — ae-a8n bounds it with its own
 * transport timeouts — because a session that arrives after the runner
 * stopped looking would be an After Effects nobody owns or closes. Once it
 * settles, the interrupted error propagates and the normal teardown path
 * closes whatever launched.
 */
async function launchSession(
  fixture: TestFixture,
  signal: AbortSignal | undefined,
): Promise<AfterEffects> {
  const launching = fixture.session();
  if (signal === undefined) {
    return launching;
  }
  let onAbort: () => void = () => {};
  const interrupted = new Promise<never>((_, rejectPromise) => {
    onAbort = () => rejectPromise(new RunInterruptedError("launch"));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([launching, interrupted]);
  } catch (error) {
    if (!(error instanceof RunInterruptedError)) {
      throw error;
    }
    // The launch is still in flight; wait for it so the session it
    // produces is owned by the fixture and reaches teardown. A launch
    // that fails meanwhile reports its own error instead — that is the
    // more actionable fact.
    await launching;
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Races the test body against its budget and the run's abort signal.
 *
 * Neither the body nor a launch can be cancelled — After Effects does not
 * take one — so losing the race only stops the runner *waiting*. What
 * happens next is the caller's job: a bounded drain, then teardown.
 */
function withBudget<T>(
  promise: Promise<T>,
  timeoutMs: number,
  title: string,
  signal: AbortSignal | undefined,
): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new TestTimeoutError(title, timeoutMs));
    }, timeoutMs);
    const onAbort = (): void => {
      cleanup();
      rejectPromise(new RunInterruptedError("body"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    promise.then(
      (value) => {
        cleanup();
        resolvePromise(value);
      },
      (error: unknown) => {
        cleanup();
        // A test body can reject with anything; normalise so the runner's
        // failure description has a consistent shape.
        rejectPromise(
          error instanceof Error ? error : new Error(`test rejected with ${String(error)}`),
        );
      },
    );
  });
}

/**
 * Closes the session within a budget. A close that never answers is
 * reported as a failed cleanup — the run must not stall forever waiting
 * for it, and the report must not claim a quit that was not observed.
 * The underlying close is left running; it may still succeed later.
 */
async function boundedTeardown(
  fixture: TestFixture,
  options: OneTestOptions,
): Promise<CleanupOutcome | undefined> {
  const teardownMs =
    options.teardownTimeoutMs ??
    Math.max(
      (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) + TEARDOWN_MARGIN_MS,
      MIN_TEARDOWN_TIMEOUT_MS,
    );
  const teardown = fixture.teardown();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<CleanupOutcome>((resolvePromise) => {
    timer = setTimeout(
      () =>
        resolvePromise({
          status: "failed",
          name: "TeardownTimeoutError",
          message: `session teardown did not complete within ${teardownMs}ms`,
        }),
      teardownMs,
    );
  });
  try {
    return await Promise.race([teardown, expired]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    // teardown() resolves to an outcome and never rejects, but if the
    // race already lost, keep a handler attached so a late rejection can
    // never surface as unhandled.
    void teardown.catch(() => {});
  }
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
  // The refusal's own kind is structured data, not only text: a report reader
  // has to tell "someone's AE was already running" from "nobody can say whose
  // AE this is" without parsing an English sentence.
  const ownership =
    error instanceof HostNotOwnedError
      ? {
          kind: error.kind,
          evidence: error.evidence,
          ...(error.quit === undefined ? {} : { quit: error.quit }),
          ...(error.quitReason === undefined ? {} : { quitReason: error.quitReason }),
          ...(error.closeError === undefined ? {} : { closeError: error.closeError }),
        }
      : undefined;
  return {
    name,
    message,
    ...(stack === undefined ? {} : { stack }),
    ...(ownership === undefined ? {} : { ownership }),
    lastOperations,
  };
}

export function countByStatus(results: readonly TestResult[]): Record<TestStatus, number> {
  const counts: Record<TestStatus, number> = {
    passed: 0,
    failed: 0,
    "timed-out": 0,
    interrupted: 0,
    skipped: 0,
    blocked: 0,
  };
  for (const result of results) {
    counts[result.status] += 1;
  }
  return counts;
}

/** Anything that is not a pass or a deliberate skip makes the run red. */
export function hasFailures(results: readonly TestResult[]): boolean {
  return results.some(
    (result) =>
      result.status === "failed" ||
      result.status === "timed-out" ||
      result.status === "interrupted" ||
      result.status === "blocked",
  );
}
