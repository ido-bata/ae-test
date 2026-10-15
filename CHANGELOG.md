# Changelog

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
