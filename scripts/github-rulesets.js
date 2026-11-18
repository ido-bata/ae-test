/**
 * Puts this repository's GitHub rulesets in the state docs/github-settings.md
 * describes, and nothing else.
 *
 *   node scripts/github-rulesets.js [--repo owner/name]           (dry run)
 *   node scripts/github-rulesets.js [--repo owner/name] --apply
 *
 * Needs the GitHub CLI (`gh`), logged in as a repository admin. Without
 * `--apply` it only reads and prints what it would change. With `--apply` it
 * creates a missing ruleset or replaces one whose settings differ, matched by
 * name and target, so running it again changes nothing and never adds a
 * second copy. Two rulesets with the same name and target is an error, not
 * something to guess about. Rulesets with other names are left alone.
 *
 * - `release-tag-protection` (refs/tags/v*): a release tag, once pushed, is
 *   never moved, force-pushed or deleted. Creating one is not restricted: the
 *   publish workflow's gate decides what a tag may publish. Applied first:
 *   tag integrity is the harder state to restore if a later step fails.
 * - `main-branch-protection` (refs/heads/main): changes go through a pull
 *   request, merged with a merge commit; review threads resolved; zero
 *   approvals for now; the CI jobs `check` (Linux) and
 *   `release-tooling-windows` (Windows) green, reported by GitHub Actions
 *   itself, on a branch that is up to date with main; no force push, no
 *   deletion. No linear-history rule (merge commits are the policy) and no
 *   bypass for anyone.
 *
 * The repository is public, so rulesets are enforceable; the script still
 * refuses to apply while it is not (GitHub Free does not enforce rulesets
 * on a private repository). Before applying it also checks that each
 * required check is a GitHub Actions check run that actually ran on the
 * default branch head, so a renamed job cannot leave main waiting forever
 * for a check that no longer exists. A dry run prints the plan even when
 * that check cannot be made.
 */
import { execFileSync } from "node:child_process";

import { isEntryPoint } from "./release-tag.js";

/** GitHub Actions' app id: required checks must come from it, not any app. */
export const GITHUB_ACTIONS_APP_ID = 15368;

/** The CI jobs main requires: ci.yml's Linux and Windows jobs. */
export const REQUIRED_CHECKS = ["check", "release-tooling-windows"];

/**
 * @param {readonly string[]} checks
 * @returns {Array<{ name: string, target: string, enforcement: string, conditions: object, bypass_actors: object[], rules: Array<{ type: string, parameters?: Record<string, unknown> }> }>}
 */
export function desiredRulesets(checks = REQUIRED_CHECKS) {
  return [
    {
      name: "release-tag-protection",
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
      bypass_actors: [],
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        {
          type: "update",
          parameters: { update_allows_fetch_and_merge: false, update_allows_force_push: false },
        },
      ],
    },
    {
      name: "main-branch-protection",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
      bypass_actors: [],
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        {
          type: "pull_request",
          parameters: {
            allowed_merge_methods: ["merge"],
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_approving_review_count: 0,
            required_review_thread_resolution: true,
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            do_not_enforce_on_create: false,
            strict_required_status_checks_policy: true,
            required_status_checks: checks.map((context) => ({ context, integration_id: GITHUB_ACTIONS_APP_ID })),
          },
        },
      ],
    },
  ];
}

/**
 * Where `actual` (a ruleset as GitHub returns it) differs from `desired`.
 * Only what `desired` states is compared: GitHub adds defaults of its own,
 * and those are not a difference. Order does not matter in rule lists,
 * check lists or ref patterns.
 *
 * @param {any} actual
 * @param {any} desired
 * @returns {string[]}
 */
export function differences(actual, desired) {
  /** @type {string[]} */
  const out = [];
  if (actual.enforcement !== desired.enforcement) {
    out.push(`enforcement: ${actual.enforcement} -> ${desired.enforcement}`);
  }
  for (const key of ["include", "exclude"]) {
    const have = [...(actual.conditions?.ref_name?.[key] ?? [])].sort();
    const want = [...desired.conditions.ref_name[key]].sort();
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      out.push(`conditions.ref_name.${key}: ${JSON.stringify(have)} -> ${JSON.stringify(want)}`);
    }
  }
  if ((actual.bypass_actors ?? []).length !== 0) {
    out.push(`bypass_actors: ${JSON.stringify(actual.bypass_actors)} -> []`);
  }
  const haveRules = new Map((actual.rules ?? []).map((/** @type {any} */ rule) => [rule.type, rule]));
  const wantTypes = new Set(desired.rules.map((/** @type {any} */ rule) => rule.type));
  for (const type of haveRules.keys()) {
    if (!wantTypes.has(type)) out.push(`rule ${type}: present -> absent`);
  }
  for (const want of desired.rules) {
    const have = haveRules.get(want.type);
    if (have === undefined) {
      out.push(`rule ${want.type}: absent -> present`);
      continue;
    }
    for (const [key, value] of Object.entries(want.parameters ?? {})) {
      const current = normalise(key, have.parameters?.[key]);
      const wanted = normalise(key, value);
      if (JSON.stringify(current) !== JSON.stringify(wanted)) {
        out.push(`rule ${want.type}.${key}: ${JSON.stringify(current)} -> ${JSON.stringify(wanted)}`);
      }
    }
  }
  return out;
}

/** @param {string} key @param {unknown} value */
function normalise(key, value) {
  if (!Array.isArray(value)) return value ?? null;
  if (key === "required_status_checks") {
    return value
      .map((check) => ({ context: check.context, integration_id: check.integration_id ?? null }))
      .sort((a, b) => a.context.localeCompare(b.context));
  }
  return [...value].sort();
}

/**
 * What to do with each desired ruleset, given the repository's rulesets
 * (full objects).
 *
 * @param {any[]} existing
 * @param {ReturnType<typeof desiredRulesets>} desired
 * @returns {Array<{ action: "create" | "update" | "unchanged", name: string, id?: number, changes: string[] }>}
 */
export function plan(existing, desired) {
  return desired.map((want) => {
    const matches = existing.filter((have) => have.name === want.name && have.target === want.target);
    if (matches.length > 1) {
      throw new Error(`${matches.length} rulesets named "${want.name}" (${want.target}); remove the extra ones by hand`);
    }
    const have = matches[0];
    if (have === undefined) return { action: "create", name: want.name, changes: ["new ruleset"] };
    const changes = differences(have, want);
    return { action: changes.length === 0 ? "unchanged" : "update", name: want.name, id: have.id, changes };
  });
}

/**
 * Required checks that GitHub Actions did not run on the given commit.
 * An empty list means every one of them exists.
 *
 * @param {readonly string[]} checks
 * @param {Array<{ name: string, app?: { id?: number } | null }>} checkRuns
 */
export function missingChecks(checks, checkRuns) {
  const ran = new Set(checkRuns.filter((run) => run.app?.id === GITHUB_ACTIONS_APP_ID).map((run) => run.name));
  return checks.filter((name) => !ran.has(name));
}

/** @param {string[]} args @param {string | undefined} [input] */
function gh(args, input) {
  return execFileSync("gh", args, { encoding: "utf-8", input, stdio: ["pipe", "pipe", "inherit"] });
}

/** @param {string} path */
function ghJson(path) {
  return JSON.parse(gh(["api", path]));
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  /** @type {string | undefined} */
  let repo;
  let repoSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") continue;
    if (arg === "--repo") {
      repo = args[++i];
      repoSeen = true;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
      repoSeen = true;
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  if (!repoSeen) {
    repo = gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
  }
  if (repo === undefined || repo === "" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error("--repo needs owner/name");
  }

  const info = ghJson(`repos/${repo}`);
  console.log(`${repo}: ${info.visibility}, admin=${info.permissions?.admin === true}`);

  // The checks that gate the default branch are the ones that ran on its
  // head, not on some pull request's head: a PR may be a draft, a fork, or
  // simply old, and none of those say anything about what main requires.
  const branch = info.default_branch ?? "main";
  const head = ghJson(`repos/${repo}/commits/${branch}`).sha;
  const runs = ghJson(`repos/${repo}/commits/${branch}/check-runs?per_page=100`).check_runs ?? [];
  const missing = missingChecks(REQUIRED_CHECKS, runs);
  console.log(
    `required checks on ${branch} (${String(head).slice(0, 7)}): ${missing.length === 0 ? "all present" : `missing ${missing.join(", ")}`}`,
  );

  const summaries = ghJson(`repos/${repo}/rulesets?includes_parents=false&per_page=100`);
  const existing = summaries.map((/** @type {{ id: number }} */ summary) => ghJson(`repos/${repo}/rulesets/${summary.id}`));
  const desired = desiredRulesets();
  const steps = plan(existing, desired);
  for (const step of steps) {
    console.log(`${step.action}: ${step.name}${step.id === undefined ? "" : ` (#${step.id})`}`);
    for (const change of step.action === "unchanged" ? [] : step.changes) console.log(`  ${change}`);
  }

  if (!apply) {
    console.log("dry run: nothing changed (add --apply to apply)");
    return;
  }
  if (info.visibility !== "public") throw new Error(`${repo} is ${info.visibility}: rulesets are applied only while it is public`);
  if (info.permissions?.admin !== true) throw new Error(`not an admin of ${repo}`);
  if (missing.length > 0) throw new Error(`required checks did not run on ${branch}: ${missing.join(", ")}`);

  /** @type {string[]} */
  const applied = [];
  try {
    for (const step of steps) {
      if (step.action === "unchanged") continue;
      const want = desired.find((candidate) => candidate.name === step.name);
      const body = JSON.stringify(want);
      const result =
        step.action === "create"
          ? JSON.parse(gh(["api", "--method", "POST", `repos/${repo}/rulesets`, "--input", "-"], body))
          : JSON.parse(gh(["api", "--method", "PUT", `repos/${repo}/rulesets/${step.id}`, "--input", "-"], body));
      const after = differences(ghJson(`repos/${repo}/rulesets/${result.id}`), want);
      if (after.length > 0) throw new Error(`${step.name} still differs after ${step.action}: ${after.join("; ")}`);
      applied.push(step.name);
      console.log(`${step.action}d: ${step.name} (#${result.id}), read back and matching`);
    }
  } catch (error) {
    const pending = steps
      .filter((step) => step.action !== "unchanged" && !applied.includes(step.name))
      .map((step) => step.name);
    console.error(
      `apply stopped after ${applied.length === 0 ? "nothing" : applied.join(", ")}; still pending: ${pending.length === 0 ? "nothing" : pending.join(", ")}`,
    );
    throw error;
  }
}

if (isEntryPoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
