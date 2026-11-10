/**
 * Static host extensions, through the fixture and the fake After Effects host.
 *
 * The extension module is a consumer-side fixture (`test/fixtures/host-extension.ts`).
 * `ae-a8n extension build` turns it into a host script before a session starts;
 * the fixture forwards that path to `AfterEffects.launch` and never reads or
 * rewrites the file. This test proves the wiring, not that After Effects ran:
 * the fake host is doing the hosting.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FakeAfterEffectsTransport } from "@ido-bata/ae-a8n/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TestFixture } from "../dist/index.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const EXTENSION = join(PROJECT_ROOT, "test", "fixtures", "host-extension.ts");
const AE_A8N_CLI = join(PROJECT_ROOT, "node_modules", "@ido-bata", "ae-a8n", "dist", "cli.js");

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

describe("static host extensions", () => {
  it("forwards the built host script and calls a declared method through the fake host", async () => {
    const transport = new FakeAfterEffectsTransport();
    const fixture = fixtureFor("declared", transport);
    const ae = await fixture.session();
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

  it("refuses an unknown method before sending it, naming the declared ones", async () => {
    const transport = new FakeAfterEffectsTransport();
    const fixture = fixtureFor("unknown", transport);
    const ae = await fixture.session();
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
});
