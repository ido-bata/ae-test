import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodePng } from "@ido-bata/ae-a8n/testing";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { expectFrame, SnapshotStore } from "../dist/index.js";
import type { RenderedFrame } from "../dist/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ae-test-image-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePng(name: string, changedPixel?: readonly [number, number, number]): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    encodePng(2, 2, (x, y) => {
      if (changedPixel !== undefined && x === 1 && y === 1) {
        return changedPixel;
      }
      return [10, 20, 30];
    }),
  );
  return path;
}

function writeRgbaPng(
  name: string,
  pixelAt: (x: number, y: number) => readonly [number, number, number, number],
): string {
  const path = join(dir, name);
  const png = new PNG({ width: 2, height: 2 });
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 2; x += 1) {
      const offset = (y * 2 + x) * 4;
      const [r, g, b, a] = pixelAt(x, y);
      png.data[offset] = r;
      png.data[offset + 1] = g;
      png.data[offset + 2] = b;
      png.data[offset + 3] = a;
    }
  }
  writeFileSync(path, PNG.sync.write(png));
  return path;
}

function frame(path: string): RenderedFrame {
  return { path, frame: 0, width: 2, height: 2 };
}

function snapshots(update: boolean): SnapshotStore {
  return new SnapshotStore({ dir: join(dir, "snapshots"), testId: "image", update });
}

describe("rendered frame image comparison", () => {
  it("passes identical pixels and reports the first differing pixel", async () => {
    const expectedPath = writePng("expected.png");
    const samePath = writePng("same.png");
    const changedPath = writePng("changed.png", [25, 20, 30]);
    const store = snapshots(false);

    await expectFrame(frame(samePath), store).toMatchFrame(frame(expectedPath));
    await expect(
      expectFrame(frame(changedPath), store).toMatchFrame(frame(expectedPath)),
    ).rejects.toThrow(/first difference at \(1, 1\)/);
  });

  it("honours a per-channel threshold and differing-pixel budget", async () => {
    const expectedPath = writePng("expected.png");
    const actualPath = writePng("actual.png", [25, 20, 30]);
    const store = snapshots(false);
    const assertion = expectFrame(frame(actualPath), store);

    await expect(
      assertion.toMatchFrame(frame(expectedPath), { threshold: 10, maxDiffPixels: 0 }),
    ).rejects.toThrow(/first difference at \(1, 1\)/);
    await assertion.toMatchFrame(frame(expectedPath), { threshold: 10, maxDiffPixels: 1 });
    await expect(
      assertion.toMatchFrame(frame(expectedPath), { threshold: 10, maxDiffPixelRatio: 0.2 }),
    ).rejects.toThrow(/25\.0000%/);
    await assertion.toMatchFrame(frame(expectedPath), {
      threshold: 10,
      maxDiffPixelRatio: 0.3,
    });
    await assertion.toMatchFrame(frame(expectedPath), { threshold: 20, maxDiffPixels: 1 });
    await assertion.toMatchFrame(frame(expectedPath), { threshold: 20 });
    await expect(assertion.toMatchFrame(frame(expectedPath), { threshold: 10 })).rejects.toThrow(
      /first difference at \(1, 1\)/,
    );
  });

  it("rejects frames with different dimensions instead of comparing offsets", async () => {
    const expectedPath = writePng("expected.png");
    const other = join(dir, "other.png");
    writeFileSync(other, encodePng(1, 1, () => [10, 20, 30]));
    const store = snapshots(false);

    await expect(
      expectFrame(frame(other), store).toMatchFrame(frame(expectedPath)),
    ).rejects.toThrow(/different dimensions/);
  });

  it("toDifferFromFrame rejects identical frames and resolves on real differences", async () => {
    const expectedPath = writePng("expected.png");
    const samePath = writePng("same.png");
    const changedPath = writePng("changed.png", [25, 20, 30]);
    const store = snapshots(false);

    // The regression this guards: a no-op change must not pass just because
    // the two renders landed at different paths.
    await expect(
      expectFrame(frame(samePath), store).toDifferFromFrame(frame(expectedPath)),
    ).rejects.toThrow(/match within tolerance/);
    await expectFrame(frame(changedPath), store).toDifferFromFrame(frame(expectedPath));
    await expectFrame(frame(changedPath), store).toDifferFromFrame(frame(samePath));
  });

  it("toDifferFromFrame honours tolerances as inverted match budgets", async () => {
    const expectedPath = writePng("expected.png");
    // One pixel differs by 15 in the red channel.
    const slightlyChangedPath = writePng("slightly-changed.png", [25, 20, 30]);
    const store = snapshots(false);
    const assertion = expectFrame(frame(slightlyChangedPath), store);

    // Within the threshold the frames count as equal, so "differ" fails.
    await expect(
      assertion.toDifferFromFrame(frame(expectedPath), { threshold: 20 }),
    ).rejects.toThrow(/match within tolerance/);
    // Outside it they count as different, so "differ" passes.
    await assertion.toDifferFromFrame(frame(expectedPath), { threshold: 10 });
    // A differing-pixel budget above the actual count also reads as "same".
    await expect(
      assertion.toDifferFromFrame(frame(expectedPath), { maxDiffPixels: 4 }),
    ).rejects.toThrow(/match within tolerance/);
    await assertion.toDifferFromFrame(frame(expectedPath), { maxDiffPixels: 0 });
  });

  it("counts alpha-channel differences", async () => {
    const expectedPath = writeRgbaPng("expected-alpha.png", () => [10, 20, 30, 255]);
    const actualPath = writeRgbaPng("actual-alpha.png", (x, y) =>
      x === 1 && y === 1 ? [10, 20, 30, 128] : [10, 20, 30, 255],
    );
    const store = snapshots(false);

    await expect(
      expectFrame(frame(actualPath), store).toMatchFrame(frame(expectedPath)),
    ).rejects.toThrow(/max channel delta 127/);
    await expectFrame(frame(actualPath), store).toMatchFrame(frame(expectedPath), {
      maxDiffPixels: 1,
    });
  });
});

describe("snapshot pixel tolerances", () => {
  it("keeps the digest fast path and compares pixels only after a mismatch", async () => {
    const baselinePath = writePng("baseline.png");
    const changedPath = writePng("changed.png", [25, 20, 30]);

    await expectFrame(frame(baselinePath), snapshots(true)).toMatchSnapshot("frame");

    const store = snapshots(false);
    await expect(expectFrame(frame(baselinePath), store).toMatchSnapshot("frame")).resolves.toBeUndefined();
    await expect(expectFrame(frame(changedPath), store).toMatchSnapshot("frame")).rejects.toThrow(
      /does not match its baseline/,
    );
    await expect(
      expectFrame(frame(changedPath), store).toMatchSnapshot("frame", {
        threshold: 20,
        maxDiffPixels: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it("writes a PNG baseline beside the digest baseline", async () => {
    const baselinePath = writePng("baseline.png");
    await expectFrame(frame(baselinePath), snapshots(true)).toMatchSnapshot("frame");

    const snapshotDir = join(dir, "snapshots");
    expect(readFileSync(join(snapshotDir, "image--frame.sha256"), "utf-8").trim()).toBe(
      createHash("sha256").update(readFileSync(baselinePath)).digest("hex"),
    );
    expect(readFileSync(join(snapshotDir, "image--frame.png"))).toEqual(readFileSync(baselinePath));
  });

  it("fails honestly when an old digest-only baseline has no PNG to compare", async () => {
    const baselinePath = writePng("baseline.png");
    const snapshotDir = join(dir, "snapshots");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, "image--frame.sha256"),
      `${"0".repeat(64)}\n`,
      "utf-8",
    );

    await expect(
      expectFrame(frame(baselinePath), snapshots(false)).toMatchSnapshot("frame", {
        threshold: 20,
        maxDiffPixels: 1,
      }),
    ).rejects.toThrow(/no image baseline/);
  });
});
