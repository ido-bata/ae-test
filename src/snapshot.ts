/**
 * Snapshot baselines for rendered output.
 *
 * Snapshot baselines record the rendered bytes' SHA-256 and keep a copy of the
 * baseline PNG. The digest is the default exact comparison; when a caller
 * supplies pixel tolerances and the digest differs, the PNG copy is decoded
 * for a per-pixel comparison. The rendered file itself is already kept as an
 * artifact of the run, so a mismatch is always inspectable.
 *
 * Baselines live outside the results directory (see `RunOptions.baselineDir`)
 * so a clean checkout or a fresh CI workspace can still find them, and they
 * are grouped per environment by the runner. `legacyDir` is the pre-0.2
 * location inside the results directory: it is read as a fallback so suites
 * recorded before the split keep working, but nothing is ever written there.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { RenderedFrame } from "@ido-bata/ae-a8n";

import { AssertionError } from "./expect.js";
import {
  ImageComparisonError,
  comparePngFiles,
  formatImageDifference,
  writeImageDiffArtifacts,
  type ImageComparisonOptions,
  type ImageDifference,
} from "./image.js";
import type { Artifact } from "./types.js";

export type SnapshotStoreOptions = {
  /**
   * Directory holding this environment's baseline digests and PNGs. Created
   * lazily: a run that never updates snapshots leaves no trace here.
   */
  readonly dir: string;
  /**
   * Pre-0.2 location (`<results-dir>/__snapshots__`), consulted only when a
   * baseline is missing from `dir`. Never written to.
   */
  readonly legacyDir?: string;
  /** Test id, so each test has its own snapshot namespace. */
  readonly testId: string;
  /** Write new baselines instead of comparing. */
  readonly update: boolean;
  /**
   * Per-test output directory. When set, a failed pixel comparison leaves
   * its evidence here (image copies, a diff PNG, a JSON diagnostic) and the
   * files are reported as `diff` artifacts.
   */
  readonly artifactDir?: string;
};

export class SnapshotStore {
  readonly #dir: string;
  readonly #legacyDir: string | undefined;
  readonly #testId: string;
  readonly #update: boolean;
  readonly #artifactDir: string | undefined;
  readonly #artifacts: Artifact[] = [];
  #diffSequence = 0;

  constructor(options: SnapshotStoreOptions) {
    this.#dir = options.dir;
    this.#legacyDir = options.legacyDir;
    this.#testId = options.testId;
    this.#update = options.update;
    this.#artifactDir = options.artifactDir;
  }

  /** Diff artifacts written by failed comparisons in this test. */
  get artifacts(): readonly Artifact[] {
    return this.#artifacts;
  }

  match(
    name: string,
    digest: string,
    frame: RenderedFrame,
    compareOptions?: ImageComparisonOptions,
  ): Promise<void> {
    if (this.#update) {
      this.#write(this.#pathFor(name), this.#pngPathFor(name), digest, frame);
      return Promise.resolve();
    }

    const baselinePath = this.#existing(this.#pathFor(name), this.#legacyPathFor(name));
    if (baselinePath === undefined) {
      return Promise.reject(
        new AssertionError(
          `no snapshot baseline for "${name}" at ${this.#pathFor(name)}.\n` +
            `Run with --update-snapshots to record it. Current render: ${frame.path}`,
          frame,
        ),
      );
    }

    let baseline: string;
    try {
      baseline = readFileSync(baselinePath, "utf-8").trim();
    } catch {
      return Promise.reject(
        new AssertionError(
          `snapshot baseline for "${name}" at ${baselinePath} could not be read.\n` +
            `Run with --update-snapshots to record it. Current render: ${frame.path}`,
          frame,
        ),
      );
    }

    if (baseline === digest) {
      return Promise.resolve();
    }

    if (compareOptions === undefined) {
      return Promise.reject(
        new AssertionError(
          `rendered output for "${name}" does not match its baseline.\n` +
            `  expected sha256 ${baseline}\n` +
            `  received sha256 ${digest}\n` +
            `  render: ${frame.path}\n` +
            `Pass pixel tolerances to compare decoded pixels against ${this.#pngCandidates(name).join(" or ")}.`,
          frame,
        ),
      );
    }

    const baselinePng = this.#existingPng(name);
    if (baselinePng === undefined) {
      return Promise.reject(
        new AssertionError(
          `snapshot "${name}" has a digest baseline at ${baselinePath} but no image baseline.\n` +
            `Expected one of: ${this.#pngCandidates(name).join(", ")}\n` +
            `Run with --update-snapshots to record the PNG used for pixel comparison.`,
          frame,
        ),
      );
    }

    let difference: ImageDifference;
    try {
      difference = comparePngFiles(baselinePng, frame.path, compareOptions);
    } catch (error) {
      const message = error instanceof ImageComparisonError ? error.message : String(error);
      const outcome = error instanceof Error ? error : new Error(message);
      const diff = this.recordImageFailure({
        name,
        expectedPath: baselinePng,
        actualPath: frame.path,
        outcome,
        ...(compareOptions === undefined ? {} : { options: compareOptions }),
      });
      return Promise.reject(
        new AssertionError(
          `could not compare snapshot "${name}": ${message}\n${diff.join("\n")}`,
          frame,
        ),
      );
    }

    if (!difference.passed) {
      const diff = this.recordImageFailure({
        name,
        expectedPath: baselinePng,
        actualPath: frame.path,
        outcome: difference,
        ...(compareOptions === undefined ? {} : { options: compareOptions }),
      });
      return Promise.reject(
        new AssertionError(
          `rendered output for "${name}" does not match its baseline within tolerance.\n` +
            `  expected sha256 ${baseline}\n` +
            `  received sha256 ${digest}\n` +
            `  baseline image: ${baselinePng}\n` +
            formatImageDifference(difference, compareOptions) +
            `\n${diff.join("\n")}`,
          frame,
        ),
      );
    }
    return Promise.resolve();
  }

  /**
   * Leaves diff evidence for a failed image comparison: copies of both
   * images, a diff PNG when the images can be compared pixel-wise, and a
   * JSON diagnostic. Returns the lines to append to the failure message.
   * Does nothing when no artifact directory was configured — the failure
   * itself is unchanged either way.
   */
  recordImageFailure(input: {
    readonly name: string;
    readonly expectedPath: string;
    readonly actualPath: string;
    readonly outcome: ImageDifference | ImageComparisonError | Error;
    readonly options?: ImageComparisonOptions;
  }): string[] {
    if (this.#artifactDir === undefined) {
      return [];
    }
    try {
      this.#diffSequence += 1;
      const baseName = `${this.#baseFor(input.name)}-diff-${this.#diffSequence}`;
      const written = writeImageDiffArtifacts({
        dir: join(this.#artifactDir, "diffs"),
        baseName,
        expectedPath: input.expectedPath,
        actualPath: input.actualPath,
        outcome: input.outcome,
        ...(input.options === undefined ? {} : { options: input.options }),
      });
      for (const artifact of [
        written.expectedPath,
        written.actualPath,
        written.diffPath,
        written.reportPath,
      ]) {
        if (artifact !== undefined && existsSync(artifact)) {
          this.#artifacts.push({
            name: `diffs/${basename(artifact)}`,
            path: artifact,
            bytes: statSync(artifact).size,
            kind: "diff",
          });
        }
      }
      return [
        `  diff evidence: ${written.reportPath}` +
          (written.diffPath === undefined
            ? ""
            : ` (images: ${written.expectedPath}, ${written.actualPath}, ${written.diffPath})`),
      ];
    } catch {
      // Diff evidence is diagnostic, never load-bearing: whatever went wrong
      // here must not replace the comparison failure it was meant to explain.
      return [];
    }
  }

  #pathFor(name: string): string {
    return join(this.#dir, `${this.#baseFor(name)}.sha256`);
  }

  #pngPathFor(name: string): string {
    return join(this.#dir, `${this.#baseFor(name)}.png`);
  }

  #legacyPathFor(name: string): string | undefined {
    return this.#legacyDir === undefined
      ? undefined
      : join(this.#legacyDir, `${this.#baseFor(name)}.sha256`);
  }

  #legacyPngPathFor(name: string): string | undefined {
    return this.#legacyDir === undefined
      ? undefined
      : join(this.#legacyDir, `${this.#baseFor(name)}.png`);
  }

  /** First candidate that exists on disk, primary location preferred. */
  #existing(primary: string, legacy: string | undefined): string | undefined {
    if (existsSync(primary)) {
      return primary;
    }
    return legacy !== undefined && existsSync(legacy) ? legacy : undefined;
  }

  #existingPng(name: string): string | undefined {
    return this.#existing(this.#pngPathFor(name), this.#legacyPngPathFor(name));
  }

  #pngCandidates(name: string): string[] {
    const candidates = [this.#pngPathFor(name)];
    const legacy = this.#legacyPngPathFor(name);
    if (legacy !== undefined) {
      candidates.push(legacy);
    }
    return candidates;
  }

  #baseFor(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "-");
    return `${this.#testId}--${safe}`;
  }

  #write(shaPath: string, pngPath: string, digest: string, frame: RenderedFrame): void {
    mkdirSync(this.#dir, { recursive: true });
    copyFileSync(frame.path, pngPath);
    writeFileSync(shaPath, `${digest}\n`, "utf-8");
  }
}
