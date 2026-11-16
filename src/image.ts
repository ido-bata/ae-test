/**
 * PNG pixel comparison.
 *
 * Snapshot baselines still record the rendered bytes' SHA-256, but a mismatch
 * can be judged by decoded RGBA pixels when the caller supplies tolerances.
 * `pngjs` owns PNG decoding; this module owns the metric and the failure text.
 */

import { readFileSync } from "node:fs";

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
  constructor(message: string) {
    super(message);
    this.name = "ImageComparisonError";
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

export function comparePngBuffers(
  expected: Buffer,
  actual: Buffer,
  options: ImageComparisonOptions = {},
): Omit<ImageDifference, "expectedPath" | "actualPath"> {
  const diff = compareDecodedPngs(decodeBuffer(expected), decodeBuffer(actual), { options });
  const { expectedPath: _expectedPath, actualPath: _actualPath, ...rest } = diff;
  return rest;
}

export function formatImageDifference(
  difference: ImageDifference,
  options: ImageComparisonOptions = {},
): string {
  const threshold = options.threshold ?? 0;
  const maxDiffPixels = options.maxDiffPixels ?? "unbounded";
  const maxDiffPixelRatio = options.maxDiffPixelRatio ?? "unbounded";
  const lines = [
    `  pixels: ${difference.differentPixels}/${difference.totalPixels} differ ` +
      `(${(difference.differentPixelRatio * 100).toFixed(4)}%), ` +
      `max channel delta ${difference.maxChannelDelta}`,
    `  tolerance: threshold ${threshold}, maxDiffPixels ${maxDiffPixels}, ` +
      `maxDiffPixelRatio ${maxDiffPixelRatio}`,
  ];
  if (difference.expectedPath !== "" || difference.actualPath !== "") {
    lines.splice(2, 0, `  renders: ${difference.expectedPath} -> ${difference.actualPath}`);
  }
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
  context: { expectedPath?: string; actualPath?: string; options: ImageComparisonOptions },
): ImageDifference {
  const { threshold = 0, maxDiffPixels, maxDiffPixelRatio } = context.options;
  validateOptions(threshold, maxDiffPixels ?? 0, maxDiffPixelRatio ?? 0);

  if (expected.width !== actual.width || expected.height !== actual.height) {
    throw new ImageComparisonError(
      `cannot compare renders with different dimensions: ` +
        `expected ${expected.width}×${expected.height}, received ${actual.width}×${actual.height}`,
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
    expectedPath: context.expectedPath ?? "",
    actualPath: context.actualPath ?? "",
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

function validateOptions(
  threshold: number,
  maxDiffPixels: number,
  maxDiffPixelRatio: number,
): void {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) {
    throw new ImageComparisonError(`threshold must be a number from 0 to 255, received ${threshold}`);
  }
  if (!Number.isInteger(maxDiffPixels) || maxDiffPixels < 0) {
    throw new ImageComparisonError(
      `maxDiffPixels must be a non-negative integer, received ${maxDiffPixels}`,
    );
  }
  if (!Number.isFinite(maxDiffPixelRatio) || maxDiffPixelRatio < 0 || maxDiffPixelRatio > 1) {
    throw new ImageComparisonError(
      `maxDiffPixelRatio must be a number from 0 to 1, received ${maxDiffPixelRatio}`,
    );
  }
}
