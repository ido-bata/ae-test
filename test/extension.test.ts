/**
 * Static host extensions, through the fixture and the fake After Effects host.
 *
 * The extension module is a consumer-side fixture (`test/fixtures/host-extension.ts`).
 * `ae-a8n extension build` turns it into a host script before a session starts;
 * the fixture forwards that path to `AfterEffects.launch` and never reads or
 * rewrites the file. This test proves the wiring, not that After Effects ran:
 * the fake host is doing the hosting.
 *
 * The extension API (`hostScript`, `extensionMethods()`, `call()`) arrives with
 * ae-a8n #61 and is in `0.1.0-alpha.2`, the published version this package
 * pins (docs/dependency-on-ae-a8n.md). These cases are not skipped: the pin is
 * exact, so a version without the API would make this file fail, which is the
 * honest outcome for a dependency that lost something the suite uses. Before
 * that version was published, the same cases ran against the packed,
 * unpublished candidate tarball in a temporary consumer project — a throwaway
 * `file:` spec there, never committed here, which is the whole point of the
 * policy test.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AfterEffects } from "@ido-bata/ae-a8n";
import { FakeAfterEffectsTransport } from "@ido-bata/ae-a8n/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TestFixture } from "../dist/index.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const EXTENSION = join(PROJECT_ROOT, "test", "fixtures", "host-extension.ts");
const AE_A8N_CLI = join(PROJECT_ROOT, "node_modules", "@ido-bata", "ae-a8n", "dist", "cli.js");

/** What `ae-a8n` #61 adds to a session: typed in the pinned version. */
type ExtensionSession = AfterEffects & {
  extensionMethods(): readonly string[];
  call(name: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
};

describe(
  "static host extensions (the pinned ae-a8n has the extension API)",
  () => {
    let scratch: string;
    let hostScript: string;

    beforeAll(() => {
      scratch = mkdtempSync(join(tmpdir(), "ae-test-extension-"));
      hostScript = join(scratch, "host.generated.js");
      const output = execFileSync(
        process.execPath,
        [AE_A8N_CLI, "extension", "build", "--extension", EXTENSION, "--out", hostScript],
        { encoding: "utf-8" },
      );
      const built = JSON.parse(output) as { methods: readonly string[]; es3Validated: boolean };
      expect(built.methods).toEqual(["aetest.add"]);
      expect(built.es3Validated).toBe(true);
    });

    afterAll(() => {
      rmSync(scratch, { recursive: true, force: true });
    });

    function fixtureFor(name: string, transport: FakeAfterEffectsTransport): TestFixture {
      const outputDir = join(scratch, name);
      return new TestFixture(
        { id: name, title: name, file: "test/extension.test.ts", outputDir },
        { resultsDir: outputDir, transport, hostScript },
      );
    }

    it("forwards the built host script and calls a declared method through the fake host", async () => {
      const transport = new FakeAfterEffectsTransport();
      const fixture = fixtureFor("declared", transport);
      const ae = (await fixture.session()) as ExtensionSession;
      try {
        expect(ae.extensionMethods()).toEqual(["aetest.add"]);
        expect(await ae.call("aetest.add", { a: 20, b: 22 })).toBe(42);

        const calls = ae.traceEvents.filter((event) => event.op === "extension.call");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.status).toBe("ok");

        // The existing report shape already carries this: the fixture collects
        // the ae-a8n trace as an artifact, and the trace records extension calls
        // alongside built-in operations.
        const trace = fixture.collectArtifacts(ae).find((artifact) => artifact.kind === "trace");
        expect(trace).toBeDefined();
        const events = readFileSync(trace?.path ?? "", "utf-8")
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as { op: string; status: string });
        expect(events).toEqual(
          expect.arrayContaining([expect.objectContaining({ op: "extension.call", status: "ok" })]),
        );
      } finally {
        expect(await fixture.teardown()).toEqual({ status: "ok", quit: true });
      }
      expect(transport.closed).toBe(true);
    });

    it("carries the host script through the CLI, and the report names the declared method", () => {
      const spec = join(scratch, "cli.spec.mjs");
      writeFileSync(
        spec,
        `import { test } from ${JSON.stringify(
          pathToFileURL(join(PROJECT_ROOT, "dist", "index.js")).href,
        )};\n` +
          `test("calls a declared method", async ({ ae, expect }) => {\n` +
          `  expect(await ae.call("aetest.add", { a: 1, b: 2 })).toBe(3);\n` +
          `});\n`,
        "utf-8",
      );
      const resultsDir = join(scratch, "results");
      execFileSync(
        process.execPath,
        [
          join(PROJECT_ROOT, "dist", "cli.js"),
          spec,
          "--fake-host",
          "--host-script",
          hostScript,
          "--results-dir",
          resultsDir,
        ],
        { encoding: "utf-8" },
      );

      const report = JSON.parse(readFileSync(join(resultsDir, "report.json"), "utf-8")) as {
        results: Array<{ status: string; session?: { extensions?: readonly string[] } }>;
      };
      expect(report.results[0]?.status).toBe("passed");
      // The report says which methods the run could have called, so a green
      // run is attributable to one host script.
      expect(report.results[0]?.session?.extensions).toEqual(["aetest.add"]);
    });

    it("refuses an unknown method before sending it, naming the declared ones", async () => {
      const transport = new FakeAfterEffectsTransport();
      const fixture = fixtureFor("unknown", transport);
      const ae = (await fixture.session()) as ExtensionSession;
      try {
        const error = await ae.call("aetest.missing", { reason: "typo" }).then(
          () => {
            throw new Error("expected the call to be refused");
          },
          (rejection: unknown) =>
            rejection as Error & { method?: string; declared?: readonly string[] },
        );

        expect(error.name).toBe("ExtensionMethodNotFoundError");
        expect(error.message).toContain("aetest.missing");
        expect(error.method).toBe("aetest.missing");
        expect(error.declared).toEqual(["aetest.add"]);
        // The refusal happened in Node: nothing was sent, so nothing was traced.
        expect(ae.traceEvents.filter((event) => event.op === "extension.call")).toEqual([]);
      } finally {
        await fixture.teardown();
      }
    });
  },
);
