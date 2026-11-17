/**
 * PNG pixel comparison.
 *
 * Snapshot baselines still record the rendered bytes' SHA-256, but a mismatch
 * can be judged by decoded RGBA pixels when the caller supplies tolerances.
 * `pngjs` owns PNG decoding; this module owns the metric and the failure text.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PNG } from "pngjs";

export type ImageComparisonOptions = {
  /** Largest per-channel delta (0-255) still counted as equal. Default 0. */
  readonly threshold?: number;
  /** Maximum number of pixels allowed to exceed `threshold`. Unbounded when unset. */
  readonly maxDiffPixels?: number;
  /** Maximum fraction of pixels allowed to exceed `threshold`, 0-1. Unbounded when unset. */
  readonly maxDiffPixelRatio?: number;
};

export type ImageDifference = {
  readonly expectedPath: string;
  readonly actualPath: string;
  readonly width: number;
  readonly height: number;
  readonly totalPixels: number;
  readonly differentPixels: number;
  readonly differentPixelRatio: number;
  readonly maxChannelDelta: number;
  readonly firstDifference:
    | {
        readonly x: number;
        readonly y: number;
        readonly expected: readonly [number, number, number, number];
        readonly actual: readonly [number, number, number, number];
      }
    | undefined;
  readonly passed: boolean;
};

export class ImageComparisonError extends Error {
  /** Dimensions of both images when the failure is a size mismatch. */
  readonly expectedSize: { readonly width: number; readonly height: number } | undefined;
  readonly actualSize: { readonly width: number; readonly height: number } | undefined;

  constructor(
    message: string,
    sizes?: {
      expected: { readonly width: number; readonly height: number };
      actual: { readonly width: number; readonly height: number };
    },
  ) {
    super(message);
    this.name = "ImageComparisonError";
    this.expectedSize = sizes?.expected;
    this.actualSize = sizes?.actual;
  }
}

/** What a failed image comparison left behind for a human to inspect. */
export type ImageDiffArtifacts = {
  /** Copy of the expected (baseline) image, inside the results directory. */
  readonly expectedPath: string;
  /** Copy of the actual render, inside the results directory. */
  readonly actualPath: string;
  /**
   * Visualization PNG: the actual pixels with every pixel outside `threshold`
   * marked. Absent when the images could not be compared pixel-wise (a size
   * mismatch, an undecodable file) — `reportPath` still says why.
   */
  readonly diffPath: string | undefined;
  /** Structured diagnostics: sizes, counts, ratio, options, first difference. */
  readonly reportPath: string;
};

export type ImageDiffInput = {
  /** Directory the artifacts are written into (created if needed). */
  readonly dir: string;
  /** File-safe base name, e.g. `<test id>--<snapshot name>`. */
  readonly baseName: string;
  readonly expectedPath: string;
  readonly actualPath: string;
  /** The comparison outcome, or the error that kept it from completing. */
  readonly outcome: ImageDifference | Error;
  readonly options?: ImageComparisonOptions;
};

/**
 * Writes the failure evidence for an image comparison: copies of both images,
 * a diff visualization when the images can be compared pixel-wise, and a JSON
 * diagnostic record. Called only on failure — a passing comparison produces
 * nothing.
 */
export function writeImageDiffArtifacts(input: ImageDiffInput): ImageDiffArtifacts {
  mkdirSync(input.dir, { recursive: true });
  const expectedPath = join(input.dir, `${input.baseName}.expected.png`);
  const actualPath = join(input.dir, `${input.baseName}.actual.png`);
  const diffPath = join(input.dir, `${input.baseName}.diff.png`);
  const reportPath = join(input.dir, `${input.baseName}.diff.json`);

  // The copies are evidence, not load-bearing: an unreadable source (the very
  // failure this diagnostic exists for) must not replace the real assertion
  // error, so a failed copy is recorded in the report instead of thrown.
  const copyErrors: string[] = [];
  for (const [source, target] of [
    [input.expectedPath, expectedPath],
    [input.actualPath, actualPath],
  ] as const) {
    try {
      copyFileSync(source, target);
    } catch (error) {
      copyErrors.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const difference = "passed" in input.outcome ? input.outcome : undefined;
  const error =
    difference === undefined && input.outcome instanceof Error
      ? input.outcome.message
      : undefined;

  const written =
    difference === undefined
      ? undefined
      : writeDiffPng(expectedPath, actualPath, diffPath, difference, input.options?.threshold ?? 0);

  const report = {
    schema: "ae-test.image-diff/v1",
    expected: { path: expectedPath, source: input.expectedPath },
    actual: { path: actualPath, source: input.actualPath },
    diff: written === undefined ? null : { path: written },
    options: {
      threshold: input.options?.threshold ?? 0,
      maxDiffPixels: input.options?.maxDiffPixels ?? null,
      maxDiffPixelRatio: input.options?.maxDiffPixelRatio ?? null,
    },
    sizes:
      input.outcome instanceof ImageComparisonError &&
      (input.outcome.expectedSize !== undefined || input.outcome.actualSize !== undefined)
        ? {
            expected: input.outcome.expectedSize ?? null,
            actual: input.outcome.actualSize ?? null,
          }
        : null,
    difference:
      difference === undefined
        ? null
        : {
            width: difference.width,
            height: difference.height,
            totalPixels: difference.totalPixels,
            differentPixels: difference.differentPixels,
            differentPixelRatio: difference.differentPixelRatio,
            maxChannelDelta: difference.maxChannelDelta,
            firstDifference: difference.firstDifference ?? null,
          },
    error: error ?? null,
    copyErrors: copyErrors.length === 0 ? null : copyErrors,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  return { expectedPath, actualPath, diffPath: written, reportPath };
}

/**
 * The diff PNG: the actual image with every pixel outside `threshold` painted
 * magenta, so a reviewer sees where the renders diverge without pixel-peeping
 * two near-identical frames. Same dimensions only — callers check first.
 */
function writeDiffPng(
  expectedPath: string,
  actualPath: string,
  outPath: string,
  difference: ImageDifference,
  threshold: number,
): string | undefined {
  try {
    const expected = decodeBuffer(readFileSync(expectedPath));
    const actual = decodeBuffer(readFileSync(actualPath));
    if (expected.width !== actual.width || expected.height !== actual.height) {
      return undefined;
    }
    const png = new PNG({ width: actual.width, height: actual.height });
    for (let pixel = 0; pixel < difference.totalPixels; pixel += 1) {
      const offset = pixel * 4;
      let delta = 0;
      for (let channel = 0; channel < 4; channel += 1) {
        delta = Math.max(delta, Math.abs(expected.data[offset + channel]! - actual.data[offset + channel]!));
      }
      if (delta > threshold) {
        png.data[offset] = 255;
        png.data[offset + 1] = 0;
        png.data[offset + 2] = 255;
        png.data[offset + 3] = 255;
      } else {
        png.data[offset] = actual.data[offset]!;
        png.data[offset + 1] = actual.data[offset + 1]!;
        png.data[offset + 2] = actual.data[offset + 2]!;
        png.data[offset + 3] = actual.data[offset + 3]!;
      }
    }
    writeFileSync(outPath, PNG.sync.write(png));
    return outPath;
  } catch {
    // A diff image is diagnostic, not load-bearing: if it cannot be produced
    // the JSON report and the image copies still stand on their own.
    return undefined;
  }
}

type DecodedPng = {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
};

export function comparePngFiles(
  expectedPath: string,
  actualPath: string,
  options: ImageComparisonOptions = {},
): ImageDifference {
  return compareDecodedPngs(
    decodePng(expectedPath, readFileSync(expectedPath)),
    decodePng(actualPath, readFileSync(actualPath)),
    { expectedPath, actualPath, options },
  );
}

export function formatImageDifference(
  difference: ImageDifference,
  options: ImageComparisonOptions = {},
): string {
  const threshold = options.threshold ?? 0;
  const maxDiffPixels = options.maxDiffPixels ?? "unbounded";
  const maxDiffPixelRatio = options.maxDiffPixelRatio ?? "unbounded";
  const lines = [
    `  renders: ${difference.expectedPath} -> ${difference.actualPath}`,
    `  pixels: ${difference.differentPixels}/${difference.totalPixels} differ ` +
      `(${(difference.differentPixelRatio * 100).toFixed(4)}%), ` +
      `max channel delta ${difference.maxChannelDelta}`,
    `  tolerance: threshold ${threshold}, maxDiffPixels ${maxDiffPixels}, ` +
      `maxDiffPixelRatio ${maxDiffPixelRatio}`,
  ];
  const first = difference.firstDifference;
  if (first !== undefined) {
    lines.push(
      `  first difference at (${first.x}, ${first.y}): ` +
        `expected rgba(${first.expected.join(", ")}), received rgba(${first.actual.join(", ")})`,
    );
  }
  return lines.join("\n");
}

function compareDecodedPngs(
  expected: DecodedPng,
  actual: DecodedPng,
  context: { expectedPath: string; actualPath: string; options: ImageComparisonOptions },
): ImageDifference {
  const { threshold = 0, maxDiffPixels, maxDiffPixelRatio } = context.options;
  validateOptions(context.options);

  if (expected.width !== actual.width || expected.height !== actual.height) {
    throw new ImageComparisonError(
      `cannot compare renders with different dimensions: ` +
        `expected ${expected.width}×${expected.height}, received ${actual.width}×${actual.height}`,
      {
        expected: { width: expected.width, height: expected.height },
        actual: { width: actual.width, height: actual.height },
      },
    );
  }

  const totalPixels = expected.width * expected.height;
  let differentPixels = 0;
  let maxChannelDelta = 0;
  let firstDifference: ImageDifference["firstDifference"];

  for (let pixel = 0; pixel < totalPixels; pixel += 1) {
    const offset = pixel * 4;
    let pixelDelta = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(expected.data[offset + channel]! - actual.data[offset + channel]!);
      pixelDelta = Math.max(pixelDelta, delta);
      maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    if (pixelDelta > threshold) {
      differentPixels += 1;
      if (firstDifference === undefined) {
        const x = pixel % expected.width;
        const y = Math.floor(pixel / expected.width);
        firstDifference = {
          x,
          y,
          expected: [
            expected.data[offset]!,
            expected.data[offset + 1]!,
            expected.data[offset + 2]!,
            expected.data[offset + 3]!,
          ],
          actual: [
            actual.data[offset]!,
            actual.data[offset + 1]!,
            actual.data[offset + 2]!,
            actual.data[offset + 3]!,
          ],
        };
      }
    }
  }

  const differentPixelRatio = totalPixels === 0 ? 0 : differentPixels / totalPixels;
  const passed =
    maxDiffPixels === undefined && maxDiffPixelRatio === undefined
      ? differentPixels === 0
      : (maxDiffPixels === undefined || differentPixels <= maxDiffPixels) &&
        (maxDiffPixelRatio === undefined || differentPixelRatio <= maxDiffPixelRatio);
  return {
    expectedPath: context.expectedPath,
    actualPath: context.actualPath,
    width: expected.width,
    height: expected.height,
    totalPixels,
    differentPixels,
    differentPixelRatio,
    maxChannelDelta,
    firstDifference,
    passed,
  };
}

function decodePng(path: string, bytes: Buffer): DecodedPng {
  try {
    return decodeBuffer(bytes);
  } catch (error) {
    throw new ImageComparisonError(
      `could not decode PNG ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function decodeBuffer(bytes: Buffer): DecodedPng {
  const png = PNG.sync.read(bytes);
  return { width: png.width, height: png.height, data: png.data };
}

function validateOptions(options: ImageComparisonOptions): void {
  const { threshold = 0, maxDiffPixels, maxDiffPixelRatio } = options;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) {
    throw new ImageComparisonError(`threshold must be a number from 0 to 255, received ${threshold}`);
  }
  if (maxDiffPixels !== undefined && (!Number.isInteger(maxDiffPixels) || maxDiffPixels < 0)) {
    throw new ImageComparisonError(
      `maxDiffPixels must be a non-negative integer, received ${maxDiffPixels}`,
    );
  }
  if (
    maxDiffPixelRatio !== undefined &&
    (!Number.isFinite(maxDiffPixelRatio) || maxDiffPixelRatio < 0 || maxDiffPixelRatio > 1)
  ) {
    throw new ImageComparisonError(
      `maxDiffPixelRatio must be a number from 0 to 1, received ${maxDiffPixelRatio}`,
    );
  }
}
