# Verification

What has been checked, against what, and what it does not cover. The fake
host and the real host are reported separately on purpose: a pass on one says
nothing about the other.

## Fake host (automated, every pull request)

`.github/workflows/ci.yml`, Ubuntu, no After Effects:

- `npm ci` with `@ido-bata/ae-a8n@0.1.0-alpha.0` from registry.npmjs.org,
  integrity checked against `package-lock.json`, recorded in the job summary;
- build, typecheck, lint, 34 tests (runner, fixtures, teardown, snapshots,
  reports, the dependency pin, the version constant);
- the CLI against `specs/plugin-render.spec.ts` with `--fake-host`, recording
  then comparing snapshots;
- `scripts/check-packed-package.js`: the packed tarball installed into an
  empty project, specs importing `@ido-bata/ae-test` by name run through the
  installed `ae-test` binary; exit codes 0 / 1 / 2, `report.json`, render and
  trace artifacts.

The fake host is ae-a8n's model of After Effects (`@ido-bata/ae-a8n/testing`).
It knows effects that do not exist in After Effects (`ADBE Fake Gaussian
Blur`) and its renders are not After Effects renders.

## macOS, real After Effects (manual)

One Mac: After Effects 2026 (26.5x89, Japanese UI), macOS 27, arm64. Fixture:
a real `.aep` saved by After Effects with comp `Main` and solid `Solid 1`
(sha256 `c00489fe…`). Harness: `p5.mjs` — the `ae-test` CLI, no
`--fake-host`, run twice:

- **A, the shipped spec unchanged.** It names a fake-only effect, so the
  correct result is red: exit 1, with After Effects' own error for the
  effect. Not green is the check.
- **B, the same four tests against a real effect** (`ADBE Gaussian Blur 2`
  by match name): apply, parameter write/read-back, two renders whose bytes
  differ, a typed `EntityNotFoundError`, a snapshot compared against a
  baseline recorded in an earlier session. All four must pass, with a PNG and
  a trace collected per test.

Every run also checks: no modal dialog left in After Effects, After Effects
not left running, and the fixture's bytes unchanged.

| When (UTC) | ae-test | ae-a8n | Result |
| --- | --- | --- | --- |
| 2026-10-15 05:15–05:48 | 1261f77 (pre-release) | bb4c197, from a checkout | 20 of 20 runs passed (10 with a third-party CEP extension disabled, 10 enabled) |
| 2026-10-15 12:30 | 5d30ef6 (this release) | **0.1.0-alpha.0 from npm** | pass: B 4/4 in 21 s, snapshot matched the earlier baseline (`44c9d3df…`), every session quit; A red as intended |

Evidence (proof.json, report.json, traces, renders, a sha256 manifest) is kept
outside the repository, in the project's evidence store
(`_evidence/2026-10-15-ae-a8n-macos-real-host/`).

### Not covered

- Windows: not run. ae-test cannot run there today (ae-a8n reports ownership
  `unknown` on Windows, and ae-test refuses a session it does not own).
- Third-party plugins: only After Effects' built-in Gaussian Blur.
- Long suites: at most four tests per run; one launch and quit per test.
- Known After Effects-side risks are ae-a8n's, listed in its README: a
  third-party extension's modal alert during a long script, one stall at quit
  (not reproduced in 20 runs), a cold launch close to the 180 s readiness
  budget.
