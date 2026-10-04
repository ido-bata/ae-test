/**
 * Human-readable run output.
 *
 * A failure has to name the operation that broke, not just the assertion. The
 * ae-a8n trace already knows, so the report surfaces the last operations ahead
 * of the stack rather than making the reader go find the trace file.
 */

import type { RunSummary, TestResult } from "./types.js";
import { countByStatus, hasFailures } from "./runner.js";

const SYMBOL: Record<TestResult["status"], string> = {
  passed: "✓",
  failed: "✗",
  "timed-out": "⏱",
  skipped: "-",
};

export function formatResultLine(result: TestResult): string {
  const ms = `${result.durationMs}ms`;
  return `  ${SYMBOL[result.status]} ${result.title} (${ms})`;
}

export function formatFailure(result: TestResult): string {
  if (result.failure === undefined) {
    return "";
  }
  const lines = [
    "",
    `  ${result.title}`,
    `    ${result.failure.name}: ${result.failure.message}`,
  ];
  if (result.failure.lastOperations.length > 0) {
    lines.push("    last operations:");
    for (const op of result.failure.lastOperations) {
      lines.push(`      ${op}`);
    }
  }
  if (result.failure.stack !== undefined) {
    lines.push(...indent(result.failure.stack.split("\n").slice(1, 6), "    "));
  }
  const artifacts = result.artifacts.filter((artifact) => artifact.kind !== "trace");
  if (artifacts.length > 0) {
    lines.push("    artifacts:");
    for (const artifact of artifacts) {
      lines.push(`      ${artifact.name} (${artifact.bytes} bytes)`);
    }
  }
  return lines.join("\n");
}

export function formatSummary(summary: RunSummary): string {
  const counts = countByStatus(summary.results);
  const parts = [
    `${counts.passed} passed`,
    `${counts.failed} failed`,
    `${counts["timed-out"]} timed out`,
    `${counts.skipped} skipped`,
  ];
  return [
    "",
    `${parts.join(", ")} in ${summary.durationMs}ms`,
    `report: ${summary.reportPath}`,
  ].join("\n");
}

export function formatRun(summary: RunSummary): string {
  const blocks = [""];
  for (const result of summary.results) {
    blocks.push(formatResultLine(result));
    const failure = formatFailure(result);
    if (failure !== "") {
      blocks.push(failure);
    }
  }
  blocks.push(formatSummary(summary));
  return blocks.join("\n");
}

export function exitCodeFor(summary: RunSummary): number {
  return hasFailures(summary.results) ? 1 : 0;
}

function indent(lines: readonly string[], prefix: string): string[] {
  return lines.map((line) => `${prefix}${line}`);
}
