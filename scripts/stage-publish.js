/**
 * Stages the verified tarball on npm (npm Staged Publishing). It does not
 * publish: a maintainer approves the staged version with 2FA, and only then
 * is it installable.
 *
 *   node scripts/stage-publish.js <tarball.tgz> --expect-shasum <sha1> [--dry-run] [npm args...]
 *
 * Run from the package root. npm is the real npm CLI, run as
 * `node <npm-cli.js>` without a shell (resolveNpmCli), so the same code runs
 * on Linux, macOS and Windows. Before anything is sent it checks:
 * - the npm CLI was found and runs, is the pinned one (NPM_CLI_VERSION, when
 *   set) and is new enough for `npm stage` (11.15.0);
 * - the tarball is the one the gate checked (sha1);
 * - the dist-tag is `next`, the same as package.json publishConfig.tag.
 *
 * The tag is passed explicitly: `npm stage publish` takes publishConfig.tag
 * into the request, but its own log line reports only the command-line tag,
 * so without the flag the log says "latest" while the request says "next"
 * (npm 11.19.1). A staged package's tag cannot be changed afterwards.
 *
 * After npm answers it checks the reported name, version and shasum again,
 * and that a stage id came back. Writes `stage-id` to $GITHUB_OUTPUT and the
 * approval steps to $GITHUB_STEP_SUMMARY.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

export const DIST_TAG = "next";
export const MINIMUM_NPM = "11.15.0";

/** @param {string} a @param {string} b */
export function versionAtLeast(a, b) {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10));
  const pb = b.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * Finds the npm CLI's JavaScript entry point, so it can be run as
 * `node <npm-cli.js>`: the real npm, started without a shell. On Windows
 * `npm` is `npm.cmd`, which Node refuses to start without `shell: true`
 * (CVE-2024-27980), and a shell would re-parse the tarball path.
 *
 * In order, the first that applies wins:
 * 1. NPM_CLI_JS, set by the workflow after pinning npm. If set, it must be
 *    an existing npm-cli.js; anything else fails rather than falls through.
 * 2. npm_execpath, which npm sets for `npm run` and `npx` (so for the tests).
 *    Used only when it is npm's own CLI: npx-cli.js maps to its sibling
 *    npm-cli.js; pnpm's or yarn's are ignored.
 * 3. The `npm` on PATH: on Windows `<dir of npm.cmd>/node_modules/npm/bin/
 *    npm-cli.js`; elsewhere the file the `npm` symlink resolves to.
 * 4. The npm installed with this node.
 *
 * Which npm it found is not trusted by itself: the caller runs it and
 * compares its version with the pin.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   execPath?: string,
 *   platform?: string,
 *   exists?: (path: string) => boolean,
 *   realpath?: (path: string) => string,
 * }} [options]
 * @returns {{ ok: true, cli: string, source: string } | { ok: false, error: string }}
 */
export function resolveNpmCli(options = {}) {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const realpath = options.realpath ?? realpathSync;
  const path = platform === "win32" ? win32 : posix;
  const isNpmCli = (/** @type {string} */ file) => path.basename(file) === "npm-cli.js" && exists(file);

  const explicit = env.NPM_CLI_JS;
  if (explicit !== undefined && explicit !== "") {
    return isNpmCli(explicit)
      ? { ok: true, cli: explicit, source: "NPM_CLI_JS" }
      : { ok: false, error: `NPM_CLI_JS is ${explicit}, which is not an existing npm-cli.js` };
  }

  const tried = [];
  const execpath = env.npm_execpath;
  if (execpath !== undefined && execpath !== "") {
    const candidate =
      path.basename(execpath) === "npx-cli.js" ? path.join(path.dirname(execpath), "npm-cli.js") : execpath;
    if (isNpmCli(candidate)) return { ok: true, cli: candidate, source: "npm_execpath" };
    tried.push(`npm_execpath ${execpath}`);
  }

  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter((d) => d !== "")) {
    if (platform === "win32") {
      if (!exists(path.join(dir, "npm.cmd"))) continue;
      const candidate = path.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
      if (isNpmCli(candidate)) return { ok: true, cli: candidate, source: "PATH" };
      tried.push(candidate);
      break;
    }
    const npm = path.join(dir, "npm");
    if (!exists(npm)) continue;
    let target;
    try {
      target = realpath(npm);
    } catch {
      target = npm;
    }
    if (isNpmCli(target)) return { ok: true, cli: target, source: "PATH" };
    // The first npm on PATH is the one a shell would run. If it is a shim
    // (mise, volta), do not guess past it: try the npm installed with node.
    tried.push(`${npm} -> ${target}`);
    break;
  }

  const besideNode =
    platform === "win32"
      ? path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js")
      : path.join(path.dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (isNpmCli(besideNode)) return { ok: true, cli: besideNode, source: "node install" };
  tried.push(besideNode);

  return { ok: false, error: `no npm-cli.js found; set NPM_CLI_JS. Tried: ${tried.join("; ")}` };
}

/**
 * Runs the resolved npm CLI with this node, no shell.
 *
 * @param {string} cli
 * @param {string[]} args
 */
export function runNpm(cli, args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf-8" });
}

/** @param {string} message */
function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const tarball = args.shift();
  const expectIndex = args.indexOf("--expect-shasum");
  if (tarball === undefined || expectIndex === -1 || args[expectIndex + 1] === undefined) {
    console.error("usage: stage-publish.js <tarball.tgz> --expect-shasum <sha1> [--dry-run] [npm args...]");
    process.exit(2);
  }
  const expected = args[expectIndex + 1];
  args.splice(expectIndex, 2);
  const dryRun = args.includes("--dry-run");

  const resolved = resolveNpmCli();
  if (!resolved.ok) fail(resolved.error);
  const cli = /** @type {{ cli: string, source: string }} */ (resolved).cli;
  const probe = runNpm(cli, ["--version"]);
  const npmVersion = (probe.stdout ?? "").trim();
  if (probe.status !== 0 || !/^\d+\.\d+\.\d+/.test(npmVersion)) {
    fail(`${cli} did not run as npm (exit ${probe.status}${probe.error ? `, ${probe.error.message}` : ""})`);
  }
  console.log(`npm ${npmVersion}: ${cli} (from ${/** @type {{ source: string }} */ (resolved).source})`);
  const pinned = process.env.NPM_CLI_VERSION;
  if (pinned !== undefined && pinned !== "" && npmVersion !== pinned) {
    fail(`npm is ${npmVersion}, the workflow pins ${pinned}`);
  }
  if (!versionAtLeast(npmVersion, MINIMUM_NPM)) {
    fail(`npm ${npmVersion} has no \`npm stage\`; ${MINIMUM_NPM} or later is needed`);
  }

  const actual = createHash("sha1").update(readFileSync(tarball)).digest("hex");
  if (actual !== expected) {
    fail(`${tarball} has shasum ${actual}, not the ${expected} that was verified`);
  }

  const manifest = JSON.parse(readFileSync("package.json", "utf-8"));
  if (manifest.publishConfig?.tag !== DIST_TAG) {
    fail(`publishConfig.tag is ${manifest.publishConfig?.tag}, but staging uses ${DIST_TAG}`);
  }

  const result = runNpm(cli, [
    "stage",
    "publish",
    tarball,
    "--tag",
    DIST_TAG,
    "--access",
    "public",
    "--provenance=false",
    "--json",
    ...args,
  ]);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    fail(`npm stage publish exited ${result.status}`);
  }
  if (!new RegExp(`Staging to \\S+ with tag ${DIST_TAG} and public access`).test(result.stderr)) {
    fail(`npm did not report staging with tag ${DIST_TAG}`);
  }

  /** @type {Record<string, { name: string, version: string, shasum: string, stageId?: string }>} */
  const report = JSON.parse(result.stdout);
  const staged = report[manifest.name];
  if (staged === undefined) fail(`npm reported nothing for ${manifest.name}`);
  if (staged.version !== manifest.version) fail(`npm staged ${staged.version}, package.json is ${manifest.version}`);
  if (staged.shasum !== expected) fail(`npm staged shasum ${staged.shasum}, expected ${expected}`);
  if (!dryRun && (staged.stageId === undefined || staged.stageId === "")) fail("npm returned no stage id");

  const id = `${manifest.name}@${manifest.version}`;
  const stageId = staged.stageId ?? "(dry run)";
  console.log(`${dryRun ? "would stage" : "staged"} ${id} with tag ${DIST_TAG}, shasum ${expected}, stage id ${stageId}`);

  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `stage-id=${stageId}\n`);
  if (process.env.GITHUB_STEP_SUMMARY && !dryRun) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `## ${id} is staged, not published`,
        "",
        `Stage id \`${stageId}\`, dist-tag \`${DIST_TAG}\`, shasum \`${expected}\`.`,
        "A maintainer approves it with 2FA (docs/releasing.md):",
        "",
        "```bash",
        `npm stage view ${stageId}`,
        `npm stage download ${stageId}   # its shasum must be ${expected}`,
        `npm stage approve ${stageId}`,
        "```",
        "",
      ].join("\n"),
    );
  }
}

if (process.argv[1]?.endsWith("stage-publish.js")) {
  main();
}
