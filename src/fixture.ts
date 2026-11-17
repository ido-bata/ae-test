/**
 * Per-test fixture: a session, an output directory, and project access.
 *
 * The session is opened before the test body and closed after it, including
 * when the test throws or times out. A leaked After Effects process is the
 * single most expensive failure mode in this framework, so the teardown path
 * is the part that gets the care.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { AfterEffects, type HostTransport } from "@ido-bata/ae-a8n";

import type {
  Artifact,
  CleanupOutcome,
  Fixture,
  FixtureDigest,
  SessionFacts,
  TestInfo,
} from "./types.js";

/**
 * After Effects was running before this run started it, or its owner is unclear.
 *
 * The two cases are kept apart in `kind`: "attached" means a host was already
 * running and was left untouched, "unknown" means this run could neither claim
 * nor rule out the host it found. An operator acts differently on each, so the
 * distinction travels in the error and into `report.json`, not only the text.
 */
export class HostNotOwnedError extends Error {
  readonly kind: "attached" | "unknown";
  readonly evidence: string;
  /**
   * What the refusal-time `close()` reported, when it answered. On "unknown"
   * ownership the host may be one this run just started, so whether it actually
   * quit is the difference between a clean refusal and a leftover process.
   */
  readonly quit: boolean | undefined;
  readonly quitReason: string | undefined;
  /** Set when the refusal-time `close()` itself threw, so no result exists. */
  readonly closeError: string | undefined;

  constructor(
    kind: "attached" | "unknown",
    evidence: string,
    close?: { readonly quit?: boolean; readonly reason?: string; readonly error?: string },
  ) {
    const tail =
      kind === "attached"
        ? "It was left untouched. Quit it and run again."
        : close?.error !== undefined
          ? `ae-test could not prove the After Effects it found is its own, and the attempt to close the session failed (${close.error}). An After Effects may still be running (possibly the one this run just started): check for a leftover process before running again.`
          : close?.quit === false
            ? "ae-test could not prove the After Effects it found is its own, so it asked the session to close — but the host reports it was not quit. An After Effects may still be running (possibly the one this run just started): check for a leftover process before running again."
            : "ae-test could not prove the After Effects it found is its own, so it asked the session to close. If an After Effects is still running afterwards, it may be a leftover this run started — quit it and run again.";
    super(
      `After Effects is ${kind === "attached" ? "already running" : "of unknown ownership"} (${evidence}); ` +
        `ae-test only runs against an After Effects it starts. ${tail}`,
    );
    this.name = "HostNotOwnedError";
    this.kind = kind;
    this.evidence = evidence;
    this.quit = close?.quit;
    this.quitReason = close?.reason;
    this.closeError = close?.error;
  }
}

/**
 * The test's context handles were revoked: the runner reached the test's
 * terminal state (settled, timed out, failed, or interrupted) and tore the
 * session down. A body that outlived its budget cannot be cancelled — this
 * error is how its remaining calls are refused instead of reaching a closed
 * session, an unlisted artifact write, or a shared baseline.
 */
export class TestContextRevokedError extends Error {
  constructor() {
    super(
      "the test's context was revoked when the test reached its terminal state; " +
        "its After Effects session, fixture and snapshot handles no longer accept work",
    );
    this.name = "TestContextRevokedError";
  }
}

export type FixtureOptions = {
  /** Root for per-test output. Each test gets a subdirectory. */
  readonly resultsDir: string;
  /** Directory holding `.aep` project fixtures. */
  readonly projectsDir?: string;
  /** Per-test After Effects budget. */
  readonly timeoutMs?: number;
  /**
   * Transport handed to every session. Supplying the fake host is how a suite
   * runs without After Effects installed; leaving it undefined uses the real
   * installation discovered on this machine.
   */
  readonly transport?: HostTransport;
  /**
   * Host script built by `ae-a8n extension build`, declaring this project's
   * static extension methods. Forwarded to `AfterEffects.launch` unchanged:
   * the fixture never reads or rewrites it.
   */
  readonly hostScript?: string;
  /** Explicit After Effects installation; forwarded unchanged. */
  readonly installDir?: string;
  /**
   * Environment variables set inside the After Effects process before anything
   * else runs. Forwarded unchanged; applied only to a host this session owns.
   */
  readonly hostEnvironment?: Readonly<Record<string, string>>;
};

export class TestFixture {
  readonly #options: FixtureOptions;
  readonly #info: TestInfo;
  #session: AfterEffects | undefined;
  readonly #attachments: Artifact[] = [];
  /** Every project fixture this test resolved, in the order it first did. */
  readonly #fixtures: FixtureDigest[] = [];
  /**
   * Set when the runner ends this test's context. Work the body left running
   * keeps its references, but every handle it was given refuses new use —
   * see `revoke`.
   */
  #revoked = false;

  constructor(info: TestInfo, options: FixtureOptions) {
    this.#info = info;
    this.#options = options;
    mkdirSync(info.outputDir, { recursive: true });
  }

  get testInfo(): TestInfo {
    return this.#info;
  }

  /**
   * Whether this test's context handles currently refuse work. The runner
   * revokes them the moment it stops attributing work to the test — when the
   * body settles, and when its budget or the run's abort cuts the wait short.
   */
  get revoked(): boolean {
    return this.#revoked;
  }

  /**
   * Ends this test's context. Idempotent; safe to call on every exit path.
   *
   * Revocation cannot cancel what the body already dispatched — an in-flight
   * operation still races teardown inside ae-a8n — it only guarantees that no
   * *new* operation, attachment, or snapshot write leaves through the handles
   * the test was given. Detached asynchronous work the body spawned is outside
   * this guarantee entirely: JavaScript offers no way to take it back.
   */
  revoke(): void {
    this.#revoked = true;
  }

  #assertActive(): void {
    if (this.#revoked) {
      throw new TestContextRevokedError();
    }
  }

  get fixture(): Fixture {
    return {
      project: (name) => this.project(name),
      projectsDir: this.#options.projectsDir ?? resolve(process.cwd(), "fixtures"),
      attach: (name, contents) => this.attach(name, contents),
    };
  }

  /**
   * Launches the session, or returns the one already open for this test.
   *
   * Refuses to run against an After Effects this run did not start: a test
   * opens projects and edits them, and an already-running AE may be someone's
   * working session. The session is ended without touching that AE.
   */
  async session(): Promise<AfterEffects> {
    if (this.#session === undefined) {
      const session = await AfterEffects.launch({
        sessionRoot: this.#info.outputDir,
        ...(this.#options.transport === undefined
          ? {}
          : { transport: this.#options.transport }),
        ...(this.#options.hostScript === undefined
          ? {}
          : { hostScript: this.#options.hostScript }),
        ...(this.#options.installDir === undefined
          ? {}
          : { installDir: this.#options.installDir }),
        ...(this.#options.hostEnvironment === undefined
          ? {}
          : { hostEnvironment: this.#options.hostEnvironment }),
        ...(this.#options.timeoutMs === undefined
          ? {}
          : { timeoutMs: this.#options.timeoutMs }),
      });
      const ownership = session.ownership();
      if (ownership.kind !== "owned") {
        // close() only quits a host the session owns, so on "unknown" the AE
        // may still be running afterwards — capture what it reported so the
        // refusal can say whether a leftover is likely.
        let close: { quit?: boolean; reason?: string; error?: string } | undefined;
        try {
          const result = await session.close();
          close = {
            quit: result.quit,
            ...(result.reason === undefined ? {} : { reason: result.reason }),
          };
        } catch (error) {
          close = { error: error instanceof Error ? error.message : String(error) };
        }
        throw new HostNotOwnedError(ownership.kind, ownership.evidence, close);
      }
      this.#session = session;
    }
    return this.#session;
  }

  /**
   * Always closes the session, even after a failure, and says how that went.
   *
   * The edits being discarded are this test's own, in an AE this run started
   * (`session()` refuses anything else), so discarding them is explicit here.
   * A failure is returned rather than thrown: it must not replace the reason a
   * test failed, and it must not be lost when the test passed either — an AE
   * that did not quit is the next test's problem.
   */
  async teardown(): Promise<CleanupOutcome | undefined> {
    const session = this.#session;
    this.#session = undefined;
    if (session === undefined) {
      return undefined;
    }
    try {
      const result = await session.close({ unsavedChanges: "discard" });
      if (!result.quit) {
        return {
          status: "failed",
          name: "HostLeftRunning",
          message: `After Effects was not quit: ${result.reason ?? "no reason given"}`,
        };
      }
      return { status: "ok", quit: true };
    } catch (error) {
      return {
        status: "failed",
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * What this test ran against, for `report.json`.
   *
   * Every read is guarded: a fact that cannot be measured is `null` (or an
   * empty list), never an exception that would replace the test's own result.
   * `uid` is this process's, so inside an isolated session it names the
   * session's account; `asid` is read from that account's GUI domain.
   */
  sessionFacts(session: AfterEffects | undefined): SessionFacts {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    let ae: SessionFacts["ae"] = null;
    if (session !== undefined) {
      try {
        const info = session.info();
        ae = { version: info.version, ...(info.build === undefined ? {} : { build: info.build }) };
      } catch {
        ae = null;
      }
    }
    return {
      uid,
      asid: readAuditSessionId(uid),
      ae,
      extensions: declaredExtensions(session),
      fixtures: [...this.#fixtures],
      transport: this.#transportKind(),
    };
  }

  /**
   * The kind of transport the session ran on. No injected transport means
   * ae-a8n's built-in script transport — the real After Effects process —
   * so the implied kind is "script-invocation". An injected transport
   * reports its own `kind`; one that cannot say records null, which is
   * unproven, never real.
   */
  #transportKind(): string | null {
    const injected = this.#options.transport;
    if (injected === undefined) {
      return "script-invocation";
    }
    return typeof injected.kind === "string" && injected.kind.length > 0
      ? injected.kind
      : null;
  }

  /**
   * Resolves a project fixture by name and asserts it exists.
   *
   * A missing fixture is a setup error, not a test failure — surfacing it as
   * "composition not found" would send the reader after the wrong problem.
   * The bytes are hashed here, once, so the run records exactly what the test
   * opened even if the file changes afterwards.
   */
  project(name: string): string {
    this.#assertActive();
    const dir = this.#options.projectsDir ?? resolve(process.cwd(), "fixtures");
    const path = resolve(dir, name);
    try {
      statSync(path);
    } catch {
      throw new Error(
        `project fixture not found: ${path}\n` +
          `Available in ${dir}: ${listOrNone(readdirSync(dir))}`,
      );
    }
    this.#recordFixture(name, path);
    return path;
  }

  #recordFixture(name: string, path: string): void {
    if (this.#fixtures.some((fixture) => fixture.path === path)) {
      return;
    }
    let sha256: string | null = null;
    try {
      sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch {
      // Named in the report as unreadable rather than dropped: the test still
      // used the path, and a digest nobody could take is worth recording.
    }
    this.#fixtures.push({ name, path, sha256 });
  }

  attach(name: string, contents: string | Uint8Array): Promise<Artifact> {
    this.#assertActive();
    const path = join(this.#info.outputDir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    const artifact: Artifact = {
      name,
      path,
      bytes: statSync(path).size,
      kind: "attachment",
    };
    this.#attachments.push(artifact);
    return Promise.resolve(artifact);
  }

  /**
   * Collects everything a test produced into the results directory: the
   * ae-a8n trace plus every rendered frame.
   */
  collectArtifacts(session: AfterEffects | undefined): Artifact[] {
    const artifacts: Artifact[] = [...this.#attachments];

    const traceSource = join(this.#info.outputDir, "trace.jsonl");
    try {
      const bytes = statSync(traceSource).size;
      artifacts.push({ name: "trace.jsonl", path: traceSource, bytes, kind: "trace" });
    } catch {
      // No session ran; nothing to collect.
    }

    if (session !== undefined) {
      for (const frame of collectRenders(session.artifactsDir, this.#info.outputDir)) {
        artifacts.push(frame);
      }
    }
    return artifacts;
  }
}

function listOrNone(entries: readonly string[]): string {
  return entries.length === 0 ? "(none)" : entries.join(", ");
}

/**
 * The audit session id of the GUI session that owns `uid`, or null.
 *
 * `launchctl print gui/<uid>` is the only unprivileged source on macOS; the
 * call is read-only and given a short budget, because this fact is recorded,
 * not fought for. Anywhere else — or for an account with no GUI session — the
 * answer is null, which is what the field documents.
 */
function readAuditSessionId(uid: number | null): number | null {
  if (process.platform !== "darwin" || uid === null) {
    return null;
  }
  try {
    const output = execFileSync("launchctl", ["print", `gui/${uid}`], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /^\s*asid = (\d+)\s*$/m.exec(output);
    return match?.[1] === undefined ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** Static host methods the session's host script declared; [] when it has none. */
function declaredExtensions(session: AfterEffects | undefined): readonly string[] {
  if (session === undefined) {
    return [];
  }
  try {
    return session.extensionMethods();
  } catch {
    return [];
  }
}

/**
 * Renders are already written under the test's output directory by ae-a8n, so
 * this finds them rather than copying them — one copy, no divergence.
 */
function collectRenders(root: string, base: string): Artifact[] {
  const found: Artifact[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.toLowerCase().endsWith(".png")) {
        found.push({
          name: relativeArtifactName(path, base),
          path,
          bytes: statSync(path).size,
          kind: "render",
        });
      }
    }
  };
  walk(root);
  return found;
}

function relativeArtifactName(path: string, base: string): string {
  return path.startsWith(base) ? path.slice(base.length + 1) : basename(path);
}

/** Copies an external file into the results directory, for fixtures to reuse. */
export function collectInto(path: string, name: string, target: string): Artifact {
  copyFileSync(path, join(target, name));
  return { name, path: join(target, name), bytes: statSync(path).size, kind: "attachment" };
}
