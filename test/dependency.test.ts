/**
 * How ae-test depends on ae-a8n (docs/dependency-on-ae-a8n.md): one exact
 * published version, its tarball pinned by integrity in the lockfile. A
 * range, a `file:` link or a git URL would make a green run unattributable.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
  dependencies: Record<string, string>;
};
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf-8")) as {
  packages: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean }>;
};

describe("the ae-a8n dependency", () => {
  const spec = manifest.dependencies["@ido-bata/ae-a8n"] ?? "";
  const locked = lock.packages["node_modules/@ido-bata/ae-a8n"];

  it("is one exact version, not a range or a link", () => {
    expect(spec).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
  });

  it("is locked to that version's tarball on the public registry, by integrity", () => {
    expect(locked?.link).toBeUndefined();
    expect(locked?.version).toBe(spec);
    expect(locked?.resolved).toBe(`https://registry.npmjs.org/@ido-bata/ae-a8n/-/ae-a8n-${spec}.tgz`);
    expect(locked?.integrity).toMatch(/^sha512-/);
  });

  it("leaves nothing of the sibling checkout in the lockfile", () => {
    expect(Object.keys(lock.packages).filter((key) => key.includes("../ae-a8n"))).toEqual([]);
  });
});
