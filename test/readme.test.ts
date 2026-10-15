/**
 * The README's code examples are part of the release: a user copies them
 * first. Every ```js block that imports `@ido-bata/ae-test` is type-checked
 * against the built package, resolved by name through the exports map, so an
 * example cannot call an API that ae-test or ae-a8n does not declare.
 *
 * Blocks containing `…` are signatures, not programs, and are skipped.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(ROOT, "README.md"), "utf-8");

const examples = [...readme.matchAll(/```js\n([\s\S]*?)```/g)]
  .map((match) => match[1] ?? "")
  .filter((code) => code.includes(`from "@ido-bata/ae-test"`) && !code.includes("…"));

describe("README examples", () => {
  it("has at least one complete example", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it("type-check against the built package", () => {
    // Inside the package root, so `@ido-bata/ae-test` resolves through this
    // package's own exports map to dist/index.d.ts, as it would for a user.
    const dir = mkdtempSync(join(ROOT, ".readme-examples-"));
    try {
      const files = examples.map((code, index) => {
        const file = join(dir, `example-${index}.mjs`);
        writeFileSync(file, code);
        return file;
      });
      const program = ts.createProgram(files, {
        allowJs: true,
        checkJs: true,
        noEmit: true,
        strict: true,
        target: ts.ScriptTarget.ES2023,
        lib: ["lib.es2023.d.ts"],
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        types: ["node"],
        skipLibCheck: true,
      });
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(diagnostics).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
