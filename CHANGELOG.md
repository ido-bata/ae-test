# Changelog

## 1.2.0

Patch-level content on the 1.x contract: runner correctness fixes from
#121. Depends on `@ido-bata/ae-a8n` `0.2.0` exactly (unchanged — the pin
moves only after a published ae-a8n carries proven Windows owned-session
evidence).

### Fixed

- **Matrix keys are unambiguous** (#121): environment matrix entries now
  key on `JSON.stringify([os, osVersion, arch, aeVersion])`, so versions
  containing separators can no longer collide.
- **Teardown is guaranteed** (#121): artifact/session-fact collection
  failures can no longer skip session teardown; collection errors are
  recorded without aborting cleanup.
- **Vanished render files are skipped, not failed** (#121): a render
  output that disappears between render and collect no longer fails the
  test run.
- Delivery docs point at the `release/1.2.0` integration line (#121).

### Verification

- `fake/mock only` for the changed paths (unit + fake-host suites green
  in CI); the macOS real-host evidence recorded for 1.1.0 covers
  unchanged code paths.
- **Not verified**: Windows real-host run of the published package —
  attempted 2026-11-20 against AE 2027; `@ido-bata/ae-a8n@0.2.0` cannot
  establish an owned Windows session (spawns a second AfterFX that never
  answers the readiness probe, or refuses `attached` when a user AE is
  already running). Both outcomes are honest failures, never false
  green. Windows support awaits an ae-a8n release with proven Windows
  owned-session evidence (#19, #21).

## 1.1.0

Minor release on the 1.x contract frozen by [docs/api.md](docs/api.md):
additive changes only. Depends on `@ido-bata/ae-a8n` `0.2.0` exactly
(unchanged).

### Added

- `--install-dir <dir>` CLI flag: explicit After Effects installation
  directory, overriding config `installDir`. CLI paths resolve against
  the working directory (#112).
- `conformance/real-host/` real-host conformance suite — **repository
  tooling, not included in the npm package** (`files` ships only `dist`,
  `examples/consumer`, `CHANGELOG.md`). It exercises the scripting
  domain of ae-a8n's built-in dispatch table through the public API on
  a disposable project and produces `real-host-verified` conformance
  records. Verified on macOS arm64 + After Effects 2026 (26.5.3x9
  build 9): 4/4 pass across record→compare runs (#112).

### Fixed

- Interrupted launches no longer lose the launched session from
  evidence: a session that resolved during an aborted launch is still
  recorded for facts, artifacts and conformance provenance (#113).
- Plugin/SDK binary hashing streams in 8 MiB chunks instead of reading
  whole files into memory (#113).
- Conformance matrix cell keys are JSON tuples, removing any chance of
  environment-string collisions (#113).
- Snapshot names that sanitize to the same baseline filename now fail
  explicitly instead of silently sharing a baseline (#113).

## 1.0.0

First stable release, published under the `latest` dist-tag. Depends on
`@ido-bata/ae-a8n` `0.2.0` exactly.

The public contract is frozen by [docs/api.md](docs/api.md): the export
surface, config/report/conformance/diff formats, CLI exit codes, timeout
and interruption semantics, context revocation, and the semver rules
(breaking changes are major-only from here). Everything since
`0.1.0-alpha.0` — the `0.2.0-beta.*` entries below — is included; breaking
changes collected during the beta period are listed in the
`0.2.0-beta.1`/`0.2.0-beta.2` sections with their migration notes.

Support statement (docs/api.md is canonical): macOS arm64 + After Effects
2026 has manual real-host evidence; Windows is unsupported; other AE
versions and OSes are unverified. Fake-host CI green is harness evidence,
not an After Effects claim.

### Breaking changes since the betas

- `SnapshotStore.matched` and `SnapshotStore.updating` getters were
  removed (#102): they were dead state — `matched` counted update-mode
  writes as matches — and nothing in the documented contract used them.
  Consumers that read them must track outcomes from `match()` results
  instead.

### Fixes carried into 1.0.0

- `expect(x).not.toMatchObject(...)` now honours negation (#100), and the
  shared matcher compares property values structurally, so a `.not`
  assertion can no longer pass on values that are in fact equal (#106).

## 0.2.0-beta.2

Depends on `@ido-bata/ae-a8n` `0.2.0` exactly. Second beta on the 0.2
train: runner lifecycle safety, test-context revocation, and the consumer
real-host lane documented since beta.1.

### Added

- Runner lifecycle safety (#43): `RunOptions.signal` interrupts a run —
  the in-flight test reports `interrupted`, unstarted tests report
  `blocked`, sessions still get a bounded teardown, and the CLI exits 130
  on SIGINT/SIGTERM (a second signal exits immediately). `teardownTimeoutMs`
  bounds `session.close()`; a close that never answers is reported as
  `TeardownTimeoutError` instead of stalling the run. `drainTimeoutMs`
  bounds how long a timed-out or interrupted body is given to settle
  before teardown; a body still running at that point is recorded as
  `failure.bodyStillRunning`. `report.json` is rewritten after every
  result with `partial: true`, so a crash leaves the evidence collected
  so far. A spec file that fails to import is now its own `failed` result
  (`failure.phase: "load"`) instead of aborting the whole run.
- `TestStatus` gains `"interrupted"`; `TestFailure.phase` gains `"load"`;
  `RunSummary` gains optional `partial`. All additive under
  `ae-test.report/v1`.
- A copyable consumer project ships in the tarball at
  `examples/consumer/` (config, a fake-host spec, and a real-host guide);
  `scripts/check-packed-package.js` now installs and runs it verbatim.
- The CLI exits 2 with a clear message when TypeScript specs are selected
  on a Node too old to strip types (<22.18), instead of failing deep in
  module resolution.
- `expectFrame(frame).toDifferFromFrame(other, options?)` (#60): the
  inverted frame comparison — it passes only when the two renders' pixels
  differ beyond the same tolerances `toMatchFrame` honours, so a no-op
  change cannot pass by producing a different file path. A failed
  "differ" leaves the same diff evidence artifacts as a failed "match".
- Test context revocation (#50, call-time check #55): once a test reaches its terminal state —
  body settled, timed out, failed, or interrupted — the handles it was
  given refuse further use with `TestContextRevokedError`. That covers
  `context.ae` and every object reachable from it (`Project`, `Comp`,
  `Layer`, `Effect`, `Parameter`, …), `fixture.project`/`attach`, and
  `expectFrame` including expectations already obtained. Revocation is
  checked again at call time, so a method reference captured before the
  terminal state (`const set = parameter.set`) is refused just like a
  property read after it. A body that outlives its budget can no longer
  dispatch new host operations, write unlisted artifacts, or touch
  snapshot baselines, and the next test proceeds once teardown succeeds.
  In-flight operations and detached asynchronous work remain outside the
  guarantee; the boundary is
  documented in `docs/api.md`. `TestContextRevokedError` is a new public
  export (minor).

### Fixed

- The consumer real-host smoke spec no longer passes as a no-op (#60): it
  asserted only that two render paths differed, picked "the first OneD"
  parameter, and ran against a fixture where Gaussian Blur changes no
  pixels. It now builds a disposable comp with a text layer at run time
  (no `.aep` fixture required), selects the Blurriness parameter by match
  name, and asserts the before/after renders differ in pixels via
  `toDifferFromFrame`.

### Changed

- `timeoutMs` semantics are now explicit: the budget covers the test body
  only. Session launch and teardown have their own bounds and are
  documented as such in `docs/api.md`, the CLI usage text and the
  `TestOptions` comment.

## 0.2.0-beta.1

Depends on `@ido-bata/ae-a8n` `0.1.0-alpha.2` exactly. First beta: breaking
changes from the alpha line are collected here; the public contract they
settle is documented in `docs/api.md`.

### Added

- Project config: `ae-test.config.json` (or `--config <file>`) carries `specs`
  globs, `projectsDir`, `resultsDir`, `baselineDir`, `timeoutMs`, `grep`,
  `capabilities`, `host` (`"real"` | `"fake"`), `hostScript`, `installDir` and
  `hostEnvironment`. Precedence is CLI > config > default per option; config
  paths resolve against the config file's directory; unknown keys and wrong
  types exit 2. `loadConfigFile` / `findConfigFile` / `discoverSpecs` and the
  `AeTestConfig` type are exported for programmatic consumers.
- Spec discovery: with no positional files, `--spec <glob>` (repeatable) or
  `specs` in config selects specs; otherwise `**/*.spec.{ts,js,mjs}` under the
  project root. `node_modules` and dot-directories are skipped, results are
  sorted and deduplicated, and an empty selection exits 2.
- `--real-host` overrides a config `"host": "fake"` for a single run.
- `HostNotOwnedError` now says which refusal it is: "attached" reports the
  host was left untouched, while "unknown" explains the After Effects may be
  a leftover this run started. The refusal-time `close()` result travels into
  `report.json` as `failure.ownership.quit` / `quitReason` / `closeError`, so
  a reader can tell a clean refusal from a possibly-running leftover without
  parsing text.
- Public contract fixed ahead of 1.0 (`docs/api.md`): the export surface is
  pinned by `test/api-surface.test.ts` and a packed-consumer type check;
  `report.json` gains a `schema: "ae-test.report/v1"` field; semver rules,
  file-format versions, the ae-a8n pin policy and the supported-environment
  statement (macOS arm64 + AE 2026 only; Windows unsupported) are documented.
- Image diff artifacts: a failed pixel comparison (`toMatchSnapshot` with
  tolerances, `toMatchFrame`, including comparisons that cannot run
  pixel-wise such as a size mismatch) now leaves evidence under the test's
  output directory — copies of both images, a `*.diff.png` marking diverging
  pixels, and a `*.diff.json` diagnostic with counts, ratio, options and the
  first difference. They appear in `report.json` as `diff` artifacts and the
  failure message points at the JSON record. `Artifact.kind` gains `"diff"`.

### Changed

- Snapshot baselines moved out of the results directory into a committed,
  environment-scoped tree. `RunOptions.baselineDir` / `--baseline-dir` selects
  the root (default `./__snapshots__`); baselines are grouped per environment
  — transport kind, and for a real host OS/arch plus the AE version and build —
  so a fake-host or different-version baseline is never compared against this
  run's renders. A normal run is read-only; `--update-snapshots` writes only
  the baselines the run compares. Baselines recorded before this change under
  `<results-dir>/__snapshots__/` are still read as a fallback but never
  written; re-run `--update-snapshots` once to migrate.

## 0.1.0-alpha.1

Depends on `@ido-bata/ae-a8n` `0.1.0-alpha.2` exactly — the first published
version that carries the static host extension API, and the reason the
extension cases now run instead of skipping. `0.1.0-alpha.2` also carries the
ae-a8n `0.1.0-alpha.1` fixes noted below.

### Added

- `FixtureOptions.hostScript` and `RunOptions.hostScript`: a host script built
  by `ae-a8n extension build`, forwarded unchanged to `AfterEffects.launch`,
  so a suite can call the static host methods its own project declares
  (`ae.call`). The fixture never reads or rewrites the script, and the fake
  host answers the same calls, so the wiring is testable without After
  Effects. `ae-test --host-script <file>` carries the same option through the
  CLI.
- `FixtureOptions.installDir` and `FixtureOptions.hostEnvironment` (also on
  `RunOptions`): forwarded unchanged to `AfterEffects.launch`, for a machine
  with more than one installation and for variables the host needs in its own
  process.
- `report.json` records, per test, what the test ran against
  (`TestResult.session`): the uid of the process that ran it and that
  account's audit session id on macOS (`launchctl print gui/<uid>`), the
  host's own version and build from the launch probe, the static methods the
  host script declared, and a SHA-256 for every project fixture the test
  resolved. A fact that cannot be measured is `null` or empty, never a
  reason to lose the test's own result.
- A refusal for an After Effects this run did not start is now structured in
  the report (`failure.ownership`): `attached` (a host was already running
  and was left untouched) is kept apart from `unknown` (ownership could not be
  decided). `HostNotOwnedError` is exported and carries `kind` and
  `evidence`.
- Pixel-level render comparison: `expectFrame(frame).toMatchFrame(other,
  options)` compares two PNGs as RGBA, and `toMatchSnapshot(name, options)`
  uses the same comparison after a digest mismatch. Options are `threshold`
  (per-channel delta), `maxDiffPixels` and `maxDiffPixelRatio`; snapshot
  updates now store the baseline PNG beside its SHA-256. Exact hash
  comparison remains the default.
- Conformance evidence producer for the ae-devtools capability contract:
  `test(..., { capabilities, conformance })` declares catalog IDs and the
  strongest claim a spec may make, and `run({ conformance })` /
  `ae-test --conformance` writes `conformance.json` with per-test records.
  Classification keeps `unsupported`, `refused`, `unknown`, `blocked`,
  `not-run`, `failed`, `fake-only` and `real-host-verified` distinct; a
  fake-host pass never promotes to real-host verification, catalog IDs are
  checked against a supplied `catalog.json`, and artifact hashes let a
  consumer recompute the evidence. Non-promotable classifications record
  `UNKNOWN` rather than `PASS`, environment fields that lack evidence stay
  `unknown`/`unproven`, and a non-ok `conformance.json` makes the CLI exit 1.
- Capability-driven selection for conformance runs: `RunOptions.capabilityFilter`
  and `ae-test --capability <id>` (repeatable) run only tests that declare at
  least one of the listed capability IDs. `fixtures/conformance/capability-catalog.json`
  is a checked-in manifest with OS and AE-version compatibility rows for the
  plugin-render capability set.
- An After Effects whose ownership cannot be decided now records conformance
  classification `unknown` / result `UNKNOWN`; only `ownership.kind ===
  "attached"` records `refused`.
- Catalog environment compatibility: when `--capability-catalog` is
  supplied, a test whose every declared capability is incompatible with this
  OS/arch is `blocked` before launch, and each conformance record flags
  capabilities incompatible with the observed AE version
  (`environment-incompatible`) or not fully evaluable
  (`environment-unverified`).
- `conformance.json` aggregates evidence for the release-candidate
  same-bytes check: `binaries.plugin` / `binaries.sdk` hash the files cited
  by `--plugin-binary` / `--sdk-binary` (repeatable), and `summary.matrix`
  groups records by observed OS × AE version.

### Changed

- A passed test that never launched a session no longer classifies as
  `fake-only` or `real-host-verified`; it records `UNKNOWN` with a
  `session-not-launched` diagnostic.
- Host promotion now requires proven transport provenance: `run()` records
  the session transport's `kind` in session facts, and classification uses
  it — `fake-in-process` is `fake-only`, `script-invocation` is
  `real-host-verified`, anything else is `unknown` and never promotes. A
  `conformance.host` declaration that disagrees with the observed
  transport adds a `host-provenance-mismatch` diagnostic and makes the
  report not ok.
- A run whose `--grep`/`--capability` filters select zero tests exits 1
  (`noTestsSelected`) instead of reporting a green run, and `conformance.json`
  reports not-ok with a `no-tests-selected` diagnostic.

- `test/extension.test.ts` runs against the published dependency: the two
  cases that were kept and skipped on `0.1.0-alpha.0` now pass, and the CLI
  case proves `--host-script` reaches the session and the report names the
  declared method.
- Through `ae` (ae-a8n `0.1.0-alpha.1`+): `ae.openProject()` rejects a
  relative path with a `TypeError` before sending anything (ae-a8n#34);
  `parameter(...).get()` and `set()` are typed `number | readonly number[]`
  (ae-a8n#21); `parameter(...).get()` on a property group rejects with
  `PropertyHasNoValueError` (ae-a8n#18); `set()` checks the value's shape on
  the host and rejects a mismatch with `ParameterValueError` (ae-a8n#21);
  `PropertyInfo` is a union on `kind` and `valueType` (ae-a8n#18/#21);
  `effect.parameters()` lists properties without a value (ae-a8n#18);
  `ae.project()` returns the open project without opening anything; and
  per-call `timeoutMs` is available on `openProject`, `renderFrame` and
  `project` (ae-a8n#22).

### Not yet

- Real After Effects verification of this version. The macOS real-host table
  in [docs/verification.md](docs/verification.md) still names
  `0.1.0-alpha.0`; nothing here has been run against a real host yet, and an
  isolated-session run needs the helper account described there.

## 0.1.0-alpha.0

First alpha, published under the `next` dist-tag. Depends on
`@ido-bata/ae-a8n` `0.1.0-alpha.0` exactly.

### Added

- `test()` / `skip()` registration, one argument destructured per test:
  `{ ae, fixture, testInfo, expect, expectFrame }`.
- A fresh After Effects session per test, launched before the body and
  closed after it — including after a failure or a timeout — discarding only
  that test's own edits.
- `expect` (sync and async, `rejects()`), `expectFrame` (`toHaveSize`,
  `toPath`, `toMatchSnapshot` by SHA-256 of the PNG bytes).
- Per-test timeouts; results `passed`, `failed`, `timed-out`, `skipped`,
  `blocked`.
- Artifacts per test (renders, the ae-a8n trace, attachments) and a
  `report.json` per run.
- The `ae-test` CLI with exit codes 0 (green), 1 (red), 2 (the run never
  happened), and `--fake-host` for runs without After Effects.

### Safety

- Refuses to run against an After Effects it did not start
  (`HostNotOwnedError`), so a test never edits someone's open session.
- Teardown counts toward the result: a test whose session did not quit is
  not reported as passed, and after a host that cannot be vouched for, the
  remaining tests are `blocked` rather than run into it.
