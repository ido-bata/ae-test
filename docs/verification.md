# Verification

What has been checked, against what, and what it does not cover. The fake
host and the real host are reported separately on purpose: a pass on one says
nothing about the other.

## Fake host (automated, every pull request)

`.github/workflows/ci.yml`, Ubuntu, no After Effects:

- `npm ci` with `@ido-bata/ae-a8n@0.2.0` from registry.npmjs.org,
  integrity checked against `package-lock.json`, recorded in the job summary;
- build, typecheck, lint, and the unit/contract test suite (runner, fixtures,
  teardown, snapshots and
  pixel-tolerant image comparison, conformance evidence classification,
  transport-provenance host promotion guards, non-ok exit status,
  capability-ID selection, environment compatibility and
  evidence aggregation, the checked-in capability
  manifest, reports, the dependency pin, the version constant, the README
  examples type-checked against `dist`, and the static-host-extension cases —
  those now run, because the pinned version is the first published one with
  the extension API);
- the CLI against `specs/plugin-render.spec.ts` with `--fake-host`, recording
  then comparing snapshots;
- `scripts/check-packed-package.js`: the packed tarball installed into an
  empty project, specs importing `@ido-bata/ae-test` by name run through the
  installed `ae-test` binary; exit codes 0 / 1 / 2, `report.json`, a
  `conformance.json` whose records are all `fake-only`, render and trace
  artifacts.

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

A second harness now exists for the same lane (#52): a clean consumer
project installs the packed release tarball and runs `ae-test` with
`installDir` pointed at AE 2026. Its spec needs no `.aep` — it builds a
disposable comp at run time — and asserts on pixels: Gaussian Blur 2
changes the render, a parameter write reaches the pixels, and a snapshot
is recorded then compared on a second run.

Provision the real-host consumer from the spec and config shipped inside
the installed package — `node_modules/@ido-bata/ae-test/examples/consumer/`
— or from a fresh checkout at the freeze SHA. Never reuse a scratch copy
kept across releases: a stale spec still asks for the pre-#60
`fixtures/real-host.aep`, which is no longer a requirement (the spec
builds a disposable comp).

| When (UTC) | ae-test | ae-a8n | Result |
| --- | --- | --- | --- |
| 2026-10-15 05:15–05:48 | 1261f77 (pre-release) | bb4c197, from a checkout | 20 of 20 runs passed (10 with a third-party CEP extension disabled, 10 enabled) |
| 2026-10-15 12:30 | 5d30ef6 (this release) | **0.1.0-alpha.0 from npm** | pass: B 4/4 in 21 s, snapshot matched the earlier baseline (`44c9d3df…`), every session quit; A red as intended |
| 2026-11-11 | 0.1.0-alpha.1 branch | `0.1.0-alpha.2` from npm | **not run.** No real-host row was produced for this branch. The *isolated* lane is blocked on machine setup (`offstage doctor`: "no computeruse account"; `ae-a8n doctor`: `A8N-SESSION-003`, uid 501 is the console uid); the *local* lane was not attempted — it needs one-time human consent in After Effects (see below). See #19 for the isolated-lane task and #52 for the local lane |
| 2026-11-17 02:38 | `7a8efdd` (RC freeze) | `0.1.0-alpha.2` pinned | **failed at launch.** The pin predates ae-a8n #106: After Effects started two same-named processes, ownership stayed `unknown`, and the run failed closed with `HostNotOwnedError` — the designed refusal, not a defect in ae-test. Both instances were left running and quit by hand. See #52 and ae-a8n #105 |
| 2026-11-17 15:51 | `381055f` (pin bump only) | `0.2.0` from npm | **failed in the spec.** Launch, ownership, render and teardown all worked on the real host; `expect(x).toBeDefined()` then failed on a defined value — an inverted matcher in ae-test itself, fixed as #65 |
| 2026-11-17 16:2x | `d80a60c` (release head: ae-a8n `0.2.0` pin + #65) | `0.2.0` from npm | **pass.** Packed consumer, two runs: `--update-snapshots` recorded the baseline, then a plain run matched it. 1/1 each (~7.5 s), `cleanup.status=ok`, `quit=true`, no After Effects process left afterwards. No script-trust dialog appeared in either run |
| 2026-11-18 00:2x–02:0x | `613bba8` / `5885643` / `b2af088` (1.0.0 RC freeze; 差分は docs のみ) | `0.2.0` from npm | **pass.** Same packed-consumer lane on the 1.0.0 tarball at each freeze SHA: two runs each, snapshot recorded then compared, 1/1 each, `cleanup.status=ok`, `quit=true`, no After Effects process left afterwards (AE 26.5.3x9 build 9, uid 501, asid 100021, transport `script-invocation`). Final RC tarball shasum `3dd6b068…` |
| 2026-11-18 04:17 | `afe47cd` / `15bc03a` (final RC freeze; tarball built at `afe47cd`, docs-only commits after) | `0.2.0` from npm | **pass.** Fresh external consumer (`/tmp/ae-test-rc-acceptance`) installed the RC tarball shasum `671ba1e3ea6f3d11ba5561aebaf062c085129a79` and ran the spec shipped inside the package: two runs — `--update-snapshots` recorded the baseline, then a plain run matched it. 1/1 each (~7.5 s / ~9.8 s), `cleanup.status=ok`, `quit=true`, trace + before/applied/after renders collected, no After Effects process left afterwards (AE 26.5.3x9 build 9, uid 501, asid 100021, transport `script-invocation`). An earlier attempt on the same tarball failed closed twice for environment reasons, not defects: a pre-existing AE process (`HostNotOwnedError`, the designed refusal) and a stale scratch consumer whose pre-#60 spec asked for `fixtures/real-host.aep` |
| 2026-11-18 07:0x | `6da3938` (re-freeze: #98/#104 rulesets fix, #100 `.not.toMatchObject` fix, #102 dead-getter removal; tarball `ido-bata-ae-test-1.0.0.tgz` shasum `af5eefb5657faa069f76ff4eb18fa09bda615c84c3ca26a5526bd73c395d24cb`) | `0.2.0` from npm | **pass.** Unit/contract suite at this SHA: 20 files / 234 tests pass. Fresh external consumer (`/tmp/ae-test-rc2-acceptance`) installed the new tarball and ran the spec shipped inside the package: fake-host lane `--update-snapshots` then plain run, 1/1 each; real-host lane `ae-test.real.config.json` two runs — `--update-snapshots` recorded the baseline, then a plain run matched it, 1/1 each (~6.7 s / ~4.7 s), `cleanup.status=ok`, `quit=true`, trace + renders collected, no After Effects process left afterwards (AE 26.5.3x9 build 9, uid 501, asid 100021, transport `script-invocation`). An earlier attempt at this SHA failed closed with `HostNotOwnedError` because a pre-existing AE (pid 65693, not started by ae-test) was running — the designed refusal, left untouched; the pass rows above it are **not** carried over as evidence for `6da3938` |

### Local console-session lane

A real-host run does not have to use the isolated lane: the rows above were
produced by running the `ae-test` CLI directly on the console desktop,
letting ae-test launch and own its own After Effects (`installDir` selects
which installation, e.g. AE 2026 over AE 2027). The packed-consumer variant
of the same lane is what #52 verifies: a third-party-shaped project installs
the release tarball and drives a real After Effects through the public API.

The human cost is consent, not code: first-launch dialogs, the scripting
file/network permission, and — when AE asks — the script-trust approval
whose granularity is still open upstream (ae-a8n #125). On 2026-11-17/18 the
two smoke runs completed without any script-trust dialog; that is two
observations on one machine and one consumer, not a general answer.
`A8N-SESSION-003` is a refusal of the *isolated* lane only — it says nothing
about the local one.

### Isolated session (not yet run at all)

`ae-a8n test --user <helper> -- npx ae-test …` is the intended shape for a
real-host run that does not use the console desktop. It is unimplemented
evidence-wise here: the helper account on this Mac has never been logged in
(`offstage session status --user test`: "none, nothing is logged in under that
account"), and the machine setup it needs — fast-user-switch login, TCC
grants, AE scripting permission, one Adobe sign-in in that session — is human
work by design (`ae-a8n setup` will not do it, and nothing here creates an
account). Until that exists, the only macOS real-host evidence remains the
console-session rows above.

`report.json` records `uid`, the GUI session's `asid` (read with
`launchctl print gui/<uid>` on macOS), the host's `version`/`build`, the
declared extension methods and the SHA-256 of every project fixture a test
resolved. The 2026-11-17 consumer runs observed these on a real host:
uid 501, asid 100021, After Effects 26.5.3x9 (build 9), transport
`script-invocation`.

Evidence (proof.json, report.json, traces, renders, a sha256 manifest) is kept
outside the repository, in the project's evidence store
(`_evidence/2026-10-15-ae-a8n-macos-real-host/`,
`_evidence/2026-11-18-beta2-real-host/`).

### Not covered

- Windows: not run. ae-test cannot run there today (ae-a8n reports ownership
  `unknown` on Windows, and ae-test refuses a session it does not own).
- Third-party plugins: only After Effects' built-in Gaussian Blur.
- Long suites: at most four tests per run; one launch and quit per test.
- Known After Effects-side risks are ae-a8n's, listed in its README: a
  third-party extension's modal alert during a long script, one stall at quit
  (not reproduced in 20 runs), a cold launch close to the 180 s readiness
  budget.
