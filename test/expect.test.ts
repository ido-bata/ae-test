/**
 * `toBeDefined` polarity (Issue #65) and `toMatchObject` negation
 * (Issue #100).
 *
 * The matchers once failed on defined values and passed on `undefined` —
 * inverted — and `toMatchObject` ignored `.not` entirely. Repo tests use
 * vitest's own `expect`, so only a spec running through the ae-test DSL
 * could catch either; these cases pin the contract directly against the
 * built entry point.
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

describe("toMatchObject", () => {
  it("passes when the subset matches", () => {
    aeExpect({ name: "x", kind: "composition", extra: 1 }).toMatchObject({
      name: "x",
      kind: "composition",
    });
  });

  it("fails when a property differs", () => {
    expect(() => aeExpect({ name: "x" }).toMatchObject({ name: "y" })).toThrow(
      AssertionError,
    );
  });

  it("fails on a non-object actual", () => {
    expect(() => aeExpect("nope").toMatchObject({ name: "x" })).toThrow(AssertionError);
  });

  it("passes under .not when the subset does not match", () => {
    aeExpect({ name: "x" }).not.toMatchObject({ name: "y" });
    aeExpect("nope").not.toMatchObject({ name: "x" });
  });

  it("fails under .not when the subset matches", () => {
    expect(() =>
      aeExpect({ name: "x", kind: "composition" }).not.toMatchObject({ name: "x" }),
    ).toThrow(AssertionError);
    expect(() => aeExpect({ name: "x" }).not.toMatchObject({ name: "x" })).toThrow(
      /expected NOT to match/,
    );
  });
});
