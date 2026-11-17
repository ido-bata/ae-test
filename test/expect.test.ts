/**
 * `toBeDefined` polarity (Issue #65).
 *
 * The matcher once failed on defined values and passed on `undefined` —
 * inverted. Repo tests use vitest's own `expect`, so only a spec running
 * through the ae-test DSL could catch it; these cases pin the contract
 * directly against the built entry point.
 */

import { describe, expect, it } from "vitest";

import { AssertionError, expect as aeExpect } from "../dist/index.js";

describe("toBeDefined", () => {
  it("passes on a defined value", () => {
    aeExpect({ a: 1 }).toBeDefined();
    aeExpect(null).toBeDefined();
    aeExpect(0).toBeDefined();
  });

  it("fails on undefined", () => {
    expect(() => aeExpect(undefined).toBeDefined()).toThrow(AssertionError);
  });

  it("passes under .not on undefined", () => {
    aeExpect(undefined).not.toBeDefined();
  });

  it("fails under .not on a defined value", () => {
    expect(() => aeExpect(1).not.toBeDefined()).toThrow(AssertionError);
  });
});
