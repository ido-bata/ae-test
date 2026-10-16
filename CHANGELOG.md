# Changelog

## 0.1.0-alpha.1 (unreleased)

Depends on `@ido-bata/ae-a8n` `0.1.0-alpha.1` exactly (was `0.1.0-alpha.0`),
which carries its fixes to users: `0.1.0-alpha.0` pins `0.1.0-alpha.0`, so
publishing ae-a8n alone reaches no one. ae-test's own API is unchanged, but
the `ae` session in every test is ae-a8n's, so its breaking changes reach
specs that use the affected calls.

### Changed (from ae-a8n; breaking for specs that use them)

- `ae.openProject()` rejects a relative path with a `TypeError` before
  sending anything (ae-a8n#34). `fixture.project(name)` returns an absolute
  path, so specs that open projects through it are unaffected.
- `parameter(...).get()` and `set()` are typed `number | readonly number[]`
  instead of `number` (ae-a8n#21). Numeric parameters still read and write
  plain numbers; a spec that does arithmetic on the result narrows first.
- `parameter(...).get()` on a property group rejects with
  `PropertyHasNoValueError` instead of resolving `undefined` (ae-a8n#18).
- `set()` checks the value's shape on the host and rejects a mismatch with
  `ParameterValueError` (ae-a8n#21).
- `PropertyInfo` is a union on `kind` and `valueType`; `value` exists only
  when `kind` is `"value"` (ae-a8n#18, ae-a8n#21).

### Added (through `ae`)

- `effect.parameters()` lists properties without a value instead of failing
  the call (ae-a8n#18).
- `ae.project()` returns the open project without opening anything; per-call
  `timeoutMs` on `openProject`, `renderFrame` and `project` (ae-a8n#22).

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
