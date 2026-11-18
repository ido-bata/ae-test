/**
 * scripts/check-release.js — the release preconditions as data. The CLI
 * wrapper is exercised by the publish workflow; these cases pin the rules
 * that keep a pre-release off `latest` and a stable on it.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const { releaseProblems } = (await import(
  pathToFileURL(fileURLToPath(new URL("../scripts/check-release.js", import.meta.url))).href
)) as {
  releaseProblems: (input: {
    version: string;
    publishConfig?: { tag?: unknown; provenance?: unknown; access?: unknown };
    constant: string | undefined;
    gitTag?: string;
  }) => string[];
};

const OK = { access: "public", provenance: false } as const;

function problems(overrides: Partial<Parameters<typeof releaseProblems>[0]> = {}): string[] {
  return releaseProblems({
    version: "1.0.0",
    publishConfig: { ...OK },
    constant: "1.0.0",
    ...overrides,
  });
}

describe("releaseProblems", () => {
  it("accepts a stable version with no publishConfig.tag (npm default latest)", () => {
    expect(problems()).toEqual([]);
  });

  it("accepts a stable version tagged latest explicitly", () => {
    expect(problems({ publishConfig: { ...OK, tag: "latest" } })).toEqual([]);
  });

  it("rejects a stable version tagged next — latest would keep pointing at the old release", () => {
    const result = problems({ publishConfig: { ...OK, tag: "next" } });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("stable 1.0.0 must publish under \"latest\"");
  });

  it("accepts a pre-release under next", () => {
    expect(
      problems({
        version: "1.0.0-beta.1",
        publishConfig: { ...OK, tag: "next" },
        constant: "1.0.0-beta.1",
      }),
    ).toEqual([]);
  });

  it.each([undefined, "latest"])("rejects a pre-release with publishConfig.tag %s", (tag) => {
    const publishConfig = tag === undefined ? { ...OK } : { ...OK, tag };
    const result = problems({
      version: "1.0.0-beta.1",
      publishConfig,
      constant: "1.0.0-beta.1",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("pre-release 1.0.0-beta.1 must publish under a non-default dist-tag");
  });

  it("rejects provenance other than false", () => {
    expect(problems({ publishConfig: { ...OK, provenance: true } })[0]).toContain("provenance must be false");
    expect(problems({ publishConfig: { access: "public" } })[0]).toContain("provenance must be false");
  });

  it("rejects non-public access", () => {
    expect(problems({ publishConfig: { ...OK, access: "restricted" } })[0]).toContain("access must be public");
  });

  it("rejects an AE_TEST_VERSION that differs from package.json", () => {
    expect(problems({ constant: "1.0.1" })[0]).toContain("AE_TEST_VERSION is 1.0.1");
    expect(problems({ constant: undefined })[0]).toContain("AE_TEST_VERSION is undefined");
  });

  it("rejects a git tag that is not v<version>", () => {
    expect(problems({ gitTag: "v1.0.1" })[0]).toContain("tag v1.0.1 does not match v1.0.0");
    expect(problems({ gitTag: "v1.0.0" })).toEqual([]);
    expect(problems({ gitTag: "" })).toEqual([]);
  });
});
