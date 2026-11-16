/**
 * Snapshot baselines for rendered output.
 *
 * Snapshot baselines record the rendered bytes' SHA-256 and keep a copy of the
 * baseline PNG. The digest is the default exact comparison; when a caller
 * supplies pixel tolerances and the digest differs, the PNG copy is decoded
 * for a per-pixel comparison. The rendered file itself is already kept as an
 * artifact of the run, so a mismatch is always inspectable.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RenderedFrame } from "@ido-bata/ae-a8n";

import { AssertionError } from "./expect.js";
import {
  ImageComparisonError,
  comparePngFiles,
  formatImageDifference,
  type ImageComparisonOptions,
  type ImageDifference,
} from "./image.js";

export type SnapshotStoreOptions = {
  /** Directory holding baseline digests. */
  readonly dir: string;
  /** Test id, so each test has its own snapshot namespace. */
  readonly testId: string;
  /** Write new baselines instead of comparing. */
  readonly update: boolean;
};

export class SnapshotStore {
  readonly #dir: string;
  readonly #testId: string;
  readonly #update: boolean;
  #matched = 0;

  constructor(options: SnapshotStoreOptions) {
    this.#dir = options.dir;
    this.#testId = options.testId;
    this.#update = options.update;
    mkdirSync(this.#dir, { recursive: true });
  }

  get matched(): number {
    return this.#matched;
  }

  get updating(): boolean {
    return this.#update;
  }

  match(
    name: string,
    digest: string,
    frame: RenderedFrame,
    compareOptions?: ImageComparisonOptions,
  ): Promise<void> {
    const path = this.#pathFor(name);

    if (this.#update) {
      this.#write(path, digest, name, frame);
      return Promise.resolve();
    }

    let baseline: string;
    try {
      baseline = readFileSync(path, "utf-8").trim();
    } catch {
      return Promise.reject(
        new AssertionError(
          `no snapshot baseline for "${name}" at ${path}.\n` +
            `Run with --update-snapshots to record it. Current render: ${frame.path}`,
          frame,
        ),
      );
    }

    if (baseline === digest) {
      this.#matched += 1;
      return Promise.resolve();
    }

    if (compareOptions === undefined) {
      return Promise.reject(
        new AssertionError(
          `rendered output for "${name}" does not match its baseline.\n` +
            `  expected sha256 ${baseline}\n` +
            `  received sha256 ${digest}\n` +
            `  render: ${frame.path}\n` +
            `Pass pixel tolerances to compare decoded pixels against ${this.#pngPathFor(name)}.`,
          frame,
        ),
      );
    }

    const baselinePng = this.#pngPathFor(name);
    if (!existsSync(baselinePng)) {
      return Promise.reject(
        new AssertionError(
          `snapshot "${name}" has a digest baseline but no image baseline at ${baselinePng}.\n` +
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
      return Promise.reject(new AssertionError(`could not compare snapshot "${name}": ${message}`, frame));
    }

    if (!difference.passed) {
      return Promise.reject(
        new AssertionError(
          `rendered output for "${name}" does not match its baseline within tolerance.\n` +
            `  expected sha256 ${baseline}\n` +
            `  received sha256 ${digest}\n` +
            formatImageDifference(difference, compareOptions),
          frame,
        ),
      );
    }
    this.#matched += 1;
    return Promise.resolve();
  }

  #pathFor(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "-");
    return join(this.#dir, `${this.#testId}--${safe}.sha256`);
  }

  #pngPathFor(name: string): string {
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "-");
    return join(this.#dir, `${this.#testId}--${safe}.png`);
  }

  #write(path: string, digest: string, name: string, frame: RenderedFrame): void {
    copyFileSync(frame.path, this.#pngPathFor(name));
    writeFileSync(path, `${digest}\n`, "utf-8");
    this.#matched += 1;
  }
}
