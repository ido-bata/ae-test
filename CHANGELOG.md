# Changelog

## Unreleased

### Added

- `FixtureOptions.hostScript` and `RunOptions.hostScript`: a host script built
  by `ae-a8n extension build`, forwarded unchanged to `AfterEffects.launch`,
  so a suite can call the static host methods its own project declares
  (`ae.call`). The fixture never reads or rewrites the script, and the fake
  host answers the same calls, so the wiring is testable without After
  Effects.

### Not yet

- The dependency stays on `@ido-bata/ae-a8n` `0.1.0-alpha.0`, the published
  version, which has no extension API. `test/extension.test.ts` skips, with
  its reason in the suite title, until the pin moves to a published version
  that has one. Both cases were run against the packed, unpublished candidate
  in a throwaway consumer project; a `file:` or `git` spec here would make a
  green run unattributable (`docs/dependency-on-ae-a8n.md`).

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
