/**
 * Assertions.
 *
 * Small on purpose. The hard problems in this domain — what a render *should*
 * look like — are snapshot and numeric questions, so that is where the surface
 * is wide. Everything here fails with a message that names the actual value,
 * because "expected true" against a PNG is useless.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import type { RenderedFrame } from "@ido-bata/ae-a8n";

import type { SnapshotStore } from "./snapshot.js";

export class AssertionError extends Error {
  /** Rendered-frame assertions carry this so the harness can attach the PNG. */
  readonly rendered: RenderedFrame | undefined;

  constructor(message: string, rendered?: RenderedFrame) {
    super(message);
    this.name = "AssertionError";
    this.rendered = rendered;
  }
}

function show(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value);
  }
  if (typeof value === "object" && value !== null) {
    try {
      const text = JSON.stringify(value);
      return text === undefined ? Object.prototype.toString.call(value) : text;
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

export class Expectation<T> {
  readonly #actual: T;
  readonly #rendered: RenderedFrame | undefined;
  #negated = false;

  constructor(actual: T, options: { rendered?: RenderedFrame } = {}) {
    this.#actual = actual;
    this.#rendered = options.rendered;
  }

  /**
   * Inverts the next matcher. `expect(a).not.toBe(b)` reads as an assertion;
   * wrapping the whole call in a try/catch reads as control flow.
   */
  get not(): Expectation<T> {
    const inverted = new Expectation<T>(
      this.#actual,
      this.#rendered === undefined ? {} : { rendered: this.#rendered },
    );
    inverted.#negated = !this.#negated;
    return inverted;
  }

  #fail(message: string): void {
    throw new AssertionError(
      this.#negated ? `expected NOT ${message}` : `expected ${message}`,
      this.#rendered,
    );
  }

  toBe(expected: T): void {
    if (Object.is(this.#actual, expected) === this.#negated) {
      this.#fail(`${show(expected)}, received ${show(this.#actual)}`);
    }
  }

  toEqual(expected: unknown): void {
    if (isDeepStrictEqual(this.#actual, expected) === this.#negated) {
      this.#fail(`${show(expected)}\n  received ${show(this.#actual)}`);
    }
  }

  /** Asserts a subset of the value's own enumerable properties. */
  toMatchObject(expected: Record<string, unknown>): void {
    toMatchObject(this.#actual, expected);
  }

  toBeDefined(): void {
    if ((this.#actual === undefined) === this.#negated) {
      this.#fail(`a defined value, received ${show(this.#actual)}`);
    }
  }

  toBeGreaterThan(minimum: number): void {
    const value = this.#numeric();
    if ((value > minimum) === this.#negated) {
      this.#fail(`a value greater than ${minimum}, received ${value}`);
    }
  }

  toBeLessThan(maximum: number): void {
    const value = this.#numeric();
    if ((value < maximum) === this.#negated) {
      this.#fail(`a value less than ${maximum}, received ${value}`);
    }
  }

  toBeCloseTo(expected: number, tolerance = 1e-6): void {
    const value = this.#numeric();
    if ((Math.abs(value - expected) <= tolerance) === this.#negated) {
      this.#fail(`${expected} ± ${tolerance}, received ${value}`);
    }
  }

  #numeric(): number {
    const value = this.#actual as unknown;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new AssertionError(
        `expected a finite number, received ${show(value)}`,
        this.#rendered,
      );
    }
    return value;
  }
}

/** A rendered frame, so `expect(frame)` can assert on pixels as well as fields. */
export class RenderedFrameExpectation {
  readonly #frame: RenderedFrame;
  readonly #snapshots: SnapshotStore;

  constructor(frame: RenderedFrame, snapshots: SnapshotStore) {
    this.#frame = frame;
    this.#snapshots = snapshots;
  }

  get frame(): RenderedFrame {
    return this.#frame;
  }

  toPath(pattern: RegExp | string): void {
    const path = this.#frame.path;
    const ok = pattern instanceof RegExp ? pattern.test(path) : path.endsWith(pattern);
    if (!ok) {
      throw new AssertionError(
        `expected render path to match ${String(pattern)}, received ${path}`,
        this.#frame,
      );
    }
  }

  toHaveSize(width: number, height: number): void {
    if (this.#frame.width !== width || this.#frame.height !== height) {
      throw new AssertionError(
        `expected a ${width}×${height} render, received ${this.#frame.width}×${this.#frame.height}`,
        this.#frame,
      );
    }
  }

  /** Compares the rendered bytes against a stored baseline. */
  async toMatchSnapshot(name: string): Promise<void> {
    const digest = this.#digest();
    await this.#snapshots.match(name, digest, this.#frame);
  }

  #digest(): string {
    try {
      return createHash("sha256").update(readFileSync(this.#frame.path)).digest("hex");
    } catch (error) {
      throw new AssertionError(
        `render artifact could not be read: ${this.#frame.path} (${(error as Error).message})`,
        this.#frame,
      );
    }
  }
}

/**
 * Expectations over a promise.
 *
 * After Effects failures are asynchronous — an unknown composition, a plugin
 * that refuses to apply — so rejection is a first-class assertion target
 * rather than something every test has to wrap in try/catch.
 */
export class AsyncExpectation<T> {
  readonly #promise: Promise<T>;
  readonly #rendered: RenderedFrame | undefined;

  constructor(promise: Promise<T>, rendered?: RenderedFrame) {
    this.#promise = promise;
    this.#rendered = rendered;
  }

  async resolves(): Promise<Expectation<T>> {
    try {
      return new Expectation(
      await this.#promise,
      this.#rendered === undefined ? {} : { rendered: this.#rendered },
    );
    } catch (error) {
      throw new AssertionError(
        `expected the operation to resolve, but it rejected: ${
          error instanceof Error ? error.message : String(error)
        }`,
        this.#rendered,
      );
    }
  }

  async rejects(): Promise<Expectation<unknown>> {
    let value: unknown;
    let rejected = false;
    try {
      value = await this.#promise;
    } catch (error) {
      rejected = true;
      value = error;
    }
    if (!rejected) {
      throw new AssertionError(
        `expected the operation to reject, but it resolved with ${show(value)}`,
        this.#rendered,
      );
    }
    return new Expectation(
      value,
      this.#rendered === undefined ? {} : { rendered: this.#rendered },
    );
  }
}

/** Matches a subset of the error's own properties. */
export function toMatchObject(value: unknown, expected: Record<string, unknown>): void {
  if (typeof value !== "object" || value === null) {
    throw new AssertionError(
      `expected an object with ${show(expected)}, received ${show(value)}`,
    );
  }
  const record = value as Record<string, unknown>;
  for (const [key, want] of Object.entries(expected)) {
    if (!Object.is(record[key], want)) {
      throw new AssertionError(
        `expected property "${key}" to be ${show(want)}, received ${show(record[key])}`,
      );
    }
  }
}

/**
 * Overloaded rather than returning a union: a union would force every call
 * site to narrow before it could reach a matcher, which is worse than the
 * problem being solved. The promise overload comes first so it wins.
 */
export function expect<T>(actual: Promise<T>, options?: ExpectOptions): AsyncExpectation<T>;
export function expect<T>(actual: T, options?: ExpectOptions): Expectation<T>;
export function expect(
  actual: unknown,
  options: ExpectOptions = {},
): Expectation<unknown> | AsyncExpectation<unknown> {
  if (isPromise(actual)) {
    return new AsyncExpectation(actual, options.rendered);
  }
  return new Expectation(actual, options);
}

export type ExpectOptions = { rendered?: RenderedFrame };

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export function expectFrame(frame: RenderedFrame, snapshots: SnapshotStore): RenderedFrameExpectation {
  return new RenderedFrameExpectation(frame, snapshots);
}
