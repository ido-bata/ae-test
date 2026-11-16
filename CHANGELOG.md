# Changelog

## 0.2.0-beta.1 (unreleased)

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
