/**
 * Snapshot baselines for rendered output.
 *
 * Renders are compared by SHA-256 of the file bytes, not by storing the PNG:
 * a baseline should be reviewable in a diff, and a wall of base64 is not. The
 * rendered file itself is already kept as an artifact of the run, so a
 * mismatch is always inspectable.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RenderedFrame } from "@ido-bata/ae-a8n";

import { AssertionError } from "./expect.js";

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

  match(name: string, digest: string, frame: RenderedFrame): Promise<void> {
    const path = this.#pathFor(name);

    if (this.#update) {
      this.#write(path, digest);
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

    if (baseline !== digest) {
      return Promise.reject(
        new AssertionError(
          `rendered output for "${name}" does not match its baseline.\n` +
            `  expected sha256 ${baseline}\n` +
            `  received sha256 ${digest}\n` +
            `  render: ${frame.path}`,
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

  #write(path: string, digest: string): void {
    writeFileSync(path, `${digest}\n`, "utf-8");
    this.#matched += 1;
  }
}
