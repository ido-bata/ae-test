# Changelog

## 0.1.0-alpha.1

Depends on `@ido-bata/ae-a8n` `0.1.0-alpha.2` exactly — the first published
version that carries the static host extension API, and the reason the
extension cases now run instead of skipping. Published from `main` after this
branch lands; the publish itself is a human action.

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

### Changed

- `test/extension.test.ts` runs against the published dependency: the two
  cases that were kept and skipped on `0.1.0-alpha.0` now pass, and the CLI
  case proves `--host-script` reaches the session and the report names the
  declared method.

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
