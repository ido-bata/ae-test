#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function stat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

function rejectSymlink(path: string): void {
  if (stat(path)?.isSymbolicLink())
    throw Error("contract symlink is not permitted: " + path);
}

function inventory(root: string, paths: string[]): Map<string, string> {
  const entries = new Map<string, string>();
  function walk(path: string): void {
    const entry = stat(path);
    if (!entry) return;
    const local = relative(root, path);
    if (entry.isSymbolicLink())
      throw Error("contract symlink is not permitted: " + local);
    if (entry.isDirectory()) {
      entries.set(local, "directory");
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else if (entry.isFile()) {
      entries.set(
        local,
        createHash("sha256")
          .update(String(entry.mode & 0o111))
          .update(readFileSync(path))
          .digest("hex"),
      );
    } else throw Error("unsupported contract entry: " + local);
  }
  for (const path of paths) walk(join(root, path));
  return entries;
}

export function changes(trusted: string, candidate: string): string[] {
  trusted = resolve(trusted);
  candidate = resolve(candidate);
  const manifest = "quality-contract.json";
  for (const root of [trusted, candidate]) {
    rejectSymlink(root);
    if (!stat(root)?.isDirectory())
      throw Error("contract root must be a directory: " + root);
    rejectSymlink(join(root, manifest));
  }
  const value: unknown = JSON.parse(
    readFileSync(join(trusted, manifest), "utf8"),
  );
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every(
      (path) =>
        typeof path === "string" &&
        path.length &&
        !isAbsolute(path) &&
        !path.includes("\\") &&
        path
          .split("/")
          .every((part) => part !== "." && part !== ".." && part !== ""),
    )
  )
    throw Error("invalid trusted contract paths");
  const paths = [manifest, ...(value as string[])];
  for (const root of [trusted, candidate]) {
    for (const path of paths) {
      let cursor = root;
      for (const part of path.split("/")) {
        cursor = join(cursor, part);
        rejectSymlink(cursor);
      }
      if (root === trusted && !stat(cursor))
        throw Error("trusted contract path is missing: " + path);
    }
  }
  const before = inventory(trusted, paths);
  const after = inventory(candidate, paths);
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .filter((path) => before.get(path) !== after.get(path));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 4)
      throw Error(
        "usage: node verify-contract.mts <trusted-root> <candidate-root>",
      );
    const changed = changes(process.argv[2], process.argv[3]);
    console.log(
      JSON.stringify({
        status: changed.length ? "CONTRACT_CHANGED" : "CONTRACT_UNCHANGED",
        changed,
      }),
    );
    process.exitCode = changed.length ? 1 : 0;
  } catch (error) {
    console.error(String(error));
    process.exitCode = 2;
  }
}
