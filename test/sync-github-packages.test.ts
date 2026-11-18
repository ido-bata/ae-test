import { describe, expect, it } from "vitest";

const script = (await import(
  new URL("../scripts/sync-github-packages.js", import.meta.url).href
)) as {
  plan: (
    version: string,
    facts: { onNpmjs: boolean; onGithub: boolean },
  ) => { action: "refuse" | "skip" | "publish"; reason: string };
  PACKAGE_NAME: string;
  GITHUB_PACKAGES_REGISTRY: string;
};

describe("GitHub Packages sync plan", () => {
  it("refuses a version that is not on npmjs", () => {
    const decision = script.plan("9.9.9", { onNpmjs: false, onGithub: false });
    expect(decision.action).toBe("refuse");
    expect(decision.reason).toContain("not on npmjs");
  });

  it("skips a version already mirrored", () => {
    const decision = script.plan("1.0.0", { onNpmjs: true, onGithub: true });
    expect(decision.action).toBe("skip");
  });

  it("publishes a version live on npmjs but absent on GitHub Packages", () => {
    const decision = script.plan("1.0.0", { onNpmjs: true, onGithub: false });
    expect(decision.action).toBe("publish");
  });

  it("targets the GitHub Packages npm registry for the scoped name", () => {
    expect(script.PACKAGE_NAME).toBe("@ido-bata/ae-test");
    expect(script.GITHUB_PACKAGES_REGISTRY).toBe("https://npm.pkg.github.com");
  });
});
