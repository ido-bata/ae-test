#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

type Patch = { path: string; before: string | null; after: string };
type Case = {
  id: string;
  expect: "accept" | "reject";
  diagnostic?: string;
  patches: Patch[];
};
type Suite = { command: string[]; timeoutMs: number; cases: Case[] };
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.includes("\\") &&
    value
      .split("/")
      .every(
        (part) =>
          part !== ".." &&
          part !== "." &&
          part !== "" &&
          ![".git", "node_modules"].includes(part),
      )
  );
}
function parse(value: unknown): Suite {
  if (
    !object(value) ||
    !Array.isArray(value.command) ||
    !value.command.length ||
    !value.command.every((x) => typeof x === "string" && x.length > 0) ||
    !Number.isSafeInteger(value.timeoutMs) ||
    Number(value.timeoutMs) < 1 ||
    Number(value.timeoutMs) > 300000 ||
    !Array.isArray(value.cases) ||
    !value.cases.length
  )
    throw Error(
      "invalid suite: command, bounded timeoutMs and nonempty cases required",
    );
  const ids = new Set<string>();
  for (const c of value.cases) {
    if (
      !object(c) ||
      typeof c.id !== "string" ||
      !c.id ||
      ids.has(c.id) ||
      !["accept", "reject"].includes(String(c.expect)) ||
      !Array.isArray(c.patches) ||
      !c.patches.length ||
      (c.expect === "reject" &&
        (typeof c.diagnostic !== "string" || !c.diagnostic.trim()))
    )
      throw Error("invalid or duplicate case");
    ids.add(c.id);
    for (const p of c.patches) {
      if (
        !object(p) ||
        !safePath(p.path) ||
        !(
          p.before === null ||
          (typeof p.before === "string" && p.before.length > 0)
        ) ||
        typeof p.after !== "string" ||
        p.before === p.after
      )
        throw Error("invalid patch path or replacement");
    }
  }
  return value as unknown as Suite;
}
function apply(root: string, patch: Patch): void {
  const target = join(root, patch.path);
  if (patch.before === null) {
    if (existsSync(target))
      throw Error("new path already exists: " + patch.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, patch.after);
    return;
  }
  const source = readFileSync(target, "utf8");
  const start = source.indexOf(patch.before);
  if (start < 0 || source.indexOf(patch.before, start + 1) >= 0)
    throw Error("patch must match exactly once: " + patch.path);
  writeFileSync(
    target,
    source.slice(0, start) +
      patch.after +
      source.slice(start + patch.before.length),
  );
}
const ignored = new Set([
  ".git",
  "node_modules",
  ".reference",
  ".tmp",
  ".DS_Store",
]);
export function snapshot(root: string): string {
  const hash = createHash("sha256");
  function walk(dir: string) {
    for (const name of readdirSync(dir).sort()) {
      if (ignored.has(name)) continue;
      const path = join(dir, name),
        stat = lstatSync(path);
      if (stat.isSymbolicLink())
        throw Error(
          "symlink requires isolated materialization: " + relative(root, path),
        );
      if (stat.isDirectory()) {
        hash.update(
          JSON.stringify([relative(root, path), stat.mode, "directory"]),
        );
        walk(path);
      } else if (stat.isFile()) {
        const contentDigest = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
        hash.update(
          JSON.stringify([relative(root, path), stat.mode, contentDigest]),
        );
      } else throw Error("unsupported source entry: " + path);
    }
  }
  walk(root);
  return hash.digest("hex");
}
function main(): number {
  const [sourceArg, suiteArg] = process.argv.slice(2);
  if (!sourceArg || !suiteArg || process.argv.length !== 4)
    throw Error(
      "usage: node challenge.mts <source-directory> <trusted-suite.json>",
    );
  const source = resolve(sourceArg),
    suiteBytes = readFileSync(resolve(suiteArg));
  const suite = parse(JSON.parse(suiteBytes.toString("utf8")));
  const sourceHash = snapshot(source);
  console.log(
    JSON.stringify({
      sourceHash,
      suiteHash: createHash("sha256").update(suiteBytes).digest("hex"),
      command: suite.command,
    }),
  );
  const scratch = mkdtempSync(join(tmpdir(), "quality-challenge-"));
  const frozen = join(scratch, "source");
  const execute = (id: string, patches: Patch[]) => {
    const candidate = join(scratch, id);
    mkdirSync(candidate);
    cpSync(frozen, candidate, { recursive: true });
    if (snapshot(candidate) !== sourceHash)
      throw Error("frozen source changed during challenge");
    for (const patch of patches) apply(candidate, patch);
    return spawnSync(suite.command[0], suite.command.slice(1), {
      cwd: candidate,
      encoding: "utf8",
      timeout: suite.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
    });
  };
  try {
    cpSync(source, frozen, {
      recursive: true,
      filter: (path) =>
        !relative(source, path)
          .split(/[\\/]/)
          .some((part) => ignored.has(part)),
    });
    if (snapshot(frozen) !== sourceHash)
      throw Error("source changed while freezing challenge");
    const baseline = execute("baseline", []);
    if (baseline.error || baseline.signal || baseline.status !== 0) {
      console.log(
        JSON.stringify({
          status: "BASELINE_FAILED",
          stdout: baseline.stdout,
          stderr: baseline.stderr,
          signal: baseline.signal,
          error: baseline.error?.message,
        }),
      );
      return 1;
    }
    let failed = false;
    for (const [index, c] of suite.cases.entries()) {
      const result = execute(String(index), c.patches);
      const status =
        result.error || result.signal
          ? "ERROR"
          : c.expect === "accept"
            ? result.status === 0
              ? "ACCEPTED"
              : "ERROR"
            : result.status === 0
              ? "SURVIVED"
              : result.status === 1 &&
                  [result.stdout, result.stderr].some((stream) =>
                    stream.split(/\r?\n/).includes(c.diagnostic!),
                  )
                ? "REJECTED"
                : "ERROR";
      console.log(
        JSON.stringify({
          id: c.id,
          status,
          exit: result.status,
          stdout: result.stdout,
          stderr: result.stderr,
          signal: result.signal,
          error: result.error?.message,
        }),
      );
      if (!["ACCEPTED", "REJECTED"].includes(status)) failed = true;
    }
    if (snapshot(source) !== sourceHash)
      throw Error("source changed during challenge");
    return failed ? 1 : 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
