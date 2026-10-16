/**
 * scripts/stage-publish.js, run with the real npm CLI against a registry
 * that records what npm sends.
 *
 * What is checked is what reaches the registry, not what npm prints: npm
 * 11.19.1's log line reports the command-line tag only, so it said "latest"
 * for requests that carried `next` (see the script's header).
 *
 * npm is started the way the script starts it, `node <npm-cli.js>` with no
 * shell, so these tests run the real npm on Windows as well (where `npm` is
 * npm.cmd, which Node will not spawn without a shell).
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../scripts/stage-publish.js", import.meta.url));
type Resolved = { ok: true; cli: string; source: string } | { ok: false; error: string };
const stage = (await import(pathToFileURL(scriptPath).href)) as {
  versionAtLeast: (a: string, b: string) => boolean;
  resolveNpmCli: (options?: {
    env?: Record<string, string | undefined>;
    execPath?: string;
    platform?: string;
    exists?: (path: string) => boolean;
    realpath?: (path: string) => string;
  }) => Resolved;
  MINIMUM_NPM: string;
  DIST_TAG: string;
};

/** The real npm CLI, found as the script finds it. */
function npmCli(): string {
  const resolved = stage.resolveNpmCli();
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.cli;
}

const NAME = "@ido-bata/ae-test";
const VERSION = "0.1.0-alpha.1";

interface Upload {
  method: string;
  url: string;
  distTags: Record<string, string>;
  versions: string[];
  attachmentSha1: string;
}

describe("versionAtLeast", () => {
  it.each([
    ["11.15.0", true],
    ["11.19.1", true],
    ["12.0.0", true],
    ["11.14.9", false],
    ["11.5.1", false],
    ["10.99.99", false],
    ["garbage", false],
  ])("%s ≥ 11.15.0 is %s", (version, expected) => {
    expect(stage.versionAtLeast(version, stage.MINIMUM_NPM)).toBe(expected);
  });
});

describe("resolveNpmCli", () => {
  /** A file system that has exactly these files; symlinks as a map. */
  function fs(files: string[], links: Record<string, string> = {}) {
    const set = new Set(files);
    return {
      exists: (path: string) => set.has(path),
      realpath: (path: string) => links[path] ?? path,
    };
  }

  const WIN_NODE = "C:\\Program Files\\nodejs";
  const WIN_CLI = win32.join(WIN_NODE, "node_modules", "npm", "bin", "npm-cli.js");
  const POSIX_CLI = "/usr/local/lib/node_modules/npm/bin/npm-cli.js";

  it("takes NPM_CLI_JS first", () => {
    const resolved = stage.resolveNpmCli({
      env: { NPM_CLI_JS: "/pinned/npm/bin/npm-cli.js", npm_execpath: POSIX_CLI },
      platform: "linux",
      ...fs(["/pinned/npm/bin/npm-cli.js", POSIX_CLI]),
    });
    expect(resolved).toEqual({ ok: true, cli: "/pinned/npm/bin/npm-cli.js", source: "NPM_CLI_JS" });
  });

  it.each([
    ["a missing file", "/nowhere/npm-cli.js"],
    ["a file that is not npm-cli.js", "/usr/local/bin/npm"],
  ])("fails, without falling through, when NPM_CLI_JS is %s", (_label, value) => {
    const resolved = stage.resolveNpmCli({
      env: { NPM_CLI_JS: value, npm_execpath: POSIX_CLI },
      platform: "linux",
      ...fs([POSIX_CLI, "/usr/local/bin/npm"]),
    });
    expect(resolved.ok).toBe(false);
    expect(resolved).toMatchObject({ error: expect.stringContaining("NPM_CLI_JS") });
  });

  it("takes npm_execpath, mapping npx-cli.js to its npm-cli.js", () => {
    const npx = "/usr/local/lib/node_modules/npm/bin/npx-cli.js";
    expect(stage.resolveNpmCli({ env: { npm_execpath: POSIX_CLI }, platform: "linux", ...fs([POSIX_CLI]) })).toMatchObject({
      ok: true,
      cli: POSIX_CLI,
      source: "npm_execpath",
    });
    expect(stage.resolveNpmCli({ env: { npm_execpath: npx }, platform: "linux", ...fs([POSIX_CLI]) })).toMatchObject({
      cli: POSIX_CLI,
      source: "npm_execpath",
    });
  });

  it("ignores another package manager's npm_execpath", () => {
    const resolved = stage.resolveNpmCli({
      env: { npm_execpath: "/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs", PATH: "/usr/local/bin" },
      platform: "linux",
      ...fs(["/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs", "/usr/local/bin/npm", POSIX_CLI], {
        "/usr/local/bin/npm": POSIX_CLI,
      }),
    });
    expect(resolved).toMatchObject({ cli: POSIX_CLI, source: "PATH" });
  });

  it("finds npm-cli.js beside npm.cmd on a Windows PATH (separated by ;)", () => {
    const resolved = stage.resolveNpmCli({
      env: { Path: `C:\\Windows\\system32;${WIN_NODE};C:\\other` },
      platform: "win32",
      execPath: "D:\\elsewhere\\node.exe",
      ...fs([win32.join(WIN_NODE, "npm.cmd"), WIN_CLI]),
    });
    expect(resolved).toEqual({ ok: true, cli: WIN_CLI, source: "PATH" });
  });

  it("follows the npm symlink on a POSIX PATH", () => {
    const resolved = stage.resolveNpmCli({
      env: { PATH: "/usr/bin:/usr/local/bin" },
      platform: "linux",
      execPath: "/opt/other/bin/node",
      ...fs(["/usr/local/bin/npm", POSIX_CLI], { "/usr/local/bin/npm": POSIX_CLI }),
    });
    expect(resolved).toEqual({ ok: true, cli: POSIX_CLI, source: "PATH" });
  });

  it("does not guess past a shim on PATH, and takes the npm installed with node", () => {
    const shim = "/home/u/.local/share/mise/shims/npm";
    const besideNode = posix.join("/opt/node/bin", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    const resolved = stage.resolveNpmCli({
      env: { PATH: "/home/u/.local/share/mise/shims:/usr/local/bin" },
      platform: "linux",
      execPath: "/opt/node/bin/node",
      ...fs([shim, "/usr/local/bin/npm", POSIX_CLI, besideNode], { "/usr/local/bin/npm": POSIX_CLI }),
    });
    expect(resolved).toEqual({ ok: true, cli: besideNode, source: "node install" });
  });

  it("takes the npm installed with node on Windows", () => {
    const resolved = stage.resolveNpmCli({
      env: { Path: "C:\\Windows" },
      platform: "win32",
      execPath: win32.join(WIN_NODE, "node.exe"),
      ...fs([WIN_CLI]),
    });
    expect(resolved).toEqual({ ok: true, cli: WIN_CLI, source: "node install" });
  });

  it("fails, naming what it tried, when there is no npm", () => {
    const resolved = stage.resolveNpmCli({
      env: { PATH: "/usr/bin" },
      platform: "linux",
      execPath: "/opt/node/bin/node",
      ...fs([]),
    });
    expect(resolved.ok).toBe(false);
    expect(resolved).toMatchObject({ error: expect.stringContaining("set NPM_CLI_JS") });
  });

  it("finds this machine's real npm with no hints, the same one npm_execpath names", async () => {
    const hintless = stage.resolveNpmCli({ env: { PATH: process.env.PATH, Path: process.env.Path } });
    expect(hintless.ok).toBe(true);
    const viaHint = npmCli();
    const version = async (cli: string) => (await run(process.execPath, [cli, "--version"])).stdout.trim();
    expect(await version((hintless as { cli: string }).cli)).toBe(await version(viaHint));
  });

  it("never starts npm through a shell or by its bare name", () => {
    // Code only: the comments explain why there is no shell.
    const script = readFileSync(scriptPath, "utf-8")
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\*|\/\*\*|\/\/)/.test(line))
      .join("\n");
    expect(script).not.toMatch(/shell\s*:/);
    expect(script).not.toMatch(/(spawnSync|spawn|execFile|execFileSync|exec)\(\s*"npm"/);
    const thisTest = readFileSync(fileURLToPath(import.meta.url), "utf-8");
    expect(thisTest).not.toMatch(/run\(\s*"npm"/);
  });
});

describe("staging with the real npm CLI", () => {
  let dir: string;
  let pkg: string;
  let tarball: string;
  let shasum: string;
  let server: Server;
  let registry: string;
  let uploads: Upload[];
  let answer: { status: number; body: string };

  function makePackage(publishConfigTag: string): void {
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: NAME,
        version: VERSION,
        license: "MIT",
        publishConfig: { access: "public", tag: publishConfigTag, provenance: false },
      }),
    );
    writeFileSync(join(pkg, "index.js"), "export {};\n");
  }

  async function pack(): Promise<void> {
    const out = join(dir, "out");
    mkdirSync(out, { recursive: true });
    await run(process.execPath, [npmCli(), "pack", "--pack-destination", out, ...npmIsolation()], { cwd: pkg });
    const [file] = readdirSync(out).filter((f) => f.endsWith(".tgz"));
    tarball = join(out, file ?? "");
    shasum = createHash("sha1").update(readFileSync(tarball)).digest("hex");
  }

  /** Keep the user's ~/.npmrc and cache out of it. */
  function npmIsolation(): string[] {
    return [`--userconfig=${join(dir, "npmrc")}`, `--cache=${join(dir, "cache")}`];
  }

  async function stageIt(
    extra: string[] = [],
    env: Record<string, string> = {},
  ): Promise<{ code: number; stdout: string; stderr: string; output: string; summary: string }> {
    const output = join(dir, "github-output");
    const summary = join(dir, "step-summary");
    writeFileSync(output, "");
    writeFileSync(summary, "");
    const host = registry.replace(/^http:/, "");
    try {
      const { stdout, stderr } = await run(
        process.execPath,
        [
          scriptPath,
          tarball,
          "--expect-shasum",
          shasum,
          `--registry=${registry}`,
          `--${host}:_authToken=fake`,
          ...npmIsolation(),
          ...extra,
        ],
        { cwd: pkg, env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env } },
      );
      return { code: 0, stdout, stderr, output: readFileSync(output, "utf-8"), summary: readFileSync(summary, "utf-8") };
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string };
      return {
        code: e.code,
        stdout: e.stdout,
        stderr: e.stderr,
        output: readFileSync(output, "utf-8"),
        summary: readFileSync(summary, "utf-8"),
      };
    }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ae-test-stage-"));
    pkg = join(dir, "pkg");
    mkdirSync(pkg);
    writeFileSync(join(dir, "npmrc"), "");
    uploads = [];
    answer = { status: 201, body: '{"stageId":"stage-test-1"}' };
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        if (req.method === "GET") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end('{"error":"Not found"}');
          return;
        }
        const doc = JSON.parse(body) as {
          "dist-tags": Record<string, string>;
          versions: Record<string, unknown>;
          _attachments: Record<string, { data: string }>;
        };
        const attachment = Object.values(doc._attachments)[0]?.data ?? "";
        uploads.push({
          method: req.method ?? "",
          url: req.url ?? "",
          distTags: doc["dist-tags"],
          versions: Object.keys(doc.versions),
          attachmentSha1: createHash("sha1").update(Buffer.from(attachment, "base64")).digest("hex"),
        });
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    makePackage("next");
    await pack();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("uploads to the stage queue, tagged next, the exact verified tarball", async () => {
    const result = await stageIt();
    expect(result.code).toBe(0);
    expect(uploads).toEqual([
      {
        method: "POST",
        url: "/-/stage/package/@ido-bata%2fae-test",
        distTags: { next: VERSION },
        versions: [VERSION],
        attachmentSha1: shasum,
      },
    ]);
    expect(result.output).toBe("stage-id=stage-test-1\n");
    expect(result.summary).toContain("npm stage approve stage-test-1");
    expect(result.summary).toContain(shasum);
  });

  it("sends nothing on a dry run", async () => {
    const result = await stageIt(["--dry-run"]);
    expect(result.code).toBe(0);
    expect(uploads).toEqual([]);
    expect(result.summary).toBe("");
  });

  it("refuses a tarball other than the verified one, before sending anything", async () => {
    writeFileSync(tarball, Buffer.concat([readFileSync(tarball), Buffer.from("x")]));
    const tampered = await stageIt();
    expect(tampered.code).toBe(1);
    expect(tampered.stderr).toContain("not the");
    expect(uploads).toEqual([]);
  });

  it("refuses when package.json would not publish to next", async () => {
    makePackage("latest");
    const result = await stageIt();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("publishConfig.tag is latest");
    expect(uploads).toEqual([]);
  });

  it("refuses an npm CLI other than the pinned one", async () => {
    const result = await stageIt([], { NPM_CLI_VERSION: "11.15.0-not-this-one" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the workflow pins");
    expect(uploads).toEqual([]);
  });

  it("stages through the npm CLI named by NPM_CLI_JS, as the workflow sets it", async () => {
    const result = await stageIt([], { NPM_CLI_JS: npmCli(), npm_execpath: "" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("(from NPM_CLI_JS)");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.attachmentSha1).toBe(shasum);
  });

  it("sends nothing when NPM_CLI_JS names no npm", async () => {
    const result = await stageIt([], { NPM_CLI_JS: join(dir, "missing", "npm-cli.js") });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("NPM_CLI_JS");
    expect(uploads).toEqual([]);
  });

  it("sends nothing when the npm-cli.js found does not run as npm", async () => {
    const broken = join(dir, "broken", "npm-cli.js");
    mkdirSync(join(dir, "broken"));
    writeFileSync(broken, "process.exit(3);\n");
    const result = await stageIt([], { NPM_CLI_JS: broken });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("did not run as npm");
    expect(uploads).toEqual([]);
  });

  it("sends nothing through an impostor that only claims the pinned version", async () => {
    const impostor = join(dir, "impostor", "npm-cli.js");
    mkdirSync(join(dir, "impostor"));
    writeFileSync(impostor, 'console.log("11.19.1");\n');
    const result = await stageIt([], { NPM_CLI_JS: impostor, NPM_CLI_VERSION: "11.19.1" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("did not report staging");
    expect(uploads).toEqual([]);
  });

  it("fails when the registry refuses, as it does for a version already staged or published", async () => {
    answer = {
      status: 403,
      body: '{"error":"You cannot publish over the previously published versions: 0.1.0-alpha.1."}',
    };
    const result = await stageIt();
    expect(result.code).toBe(1);
    expect(result.output).toBe("");
    expect(result.summary).toBe("");
  });

  it("fails when the registry gives no stage id", async () => {
    answer = { status: 201, body: "{}" };
    const result = await stageIt();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no stage id");
  });
});
