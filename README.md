# @ido-bata/ae-test

Playwright-like tests for After Effects plugins and scripts. Each test gets a
fresh After Effects session, drives it through
[`@ido-bata/ae-a8n`](https://www.npmjs.com/package/@ido-bata/ae-a8n), asserts
on what came back — values, typed errors, rendered PNGs — and leaves a trace
and the renders behind.

```js
// specs/blur.spec.mjs
import { test } from "@ido-bata/ae-test";

test("Gaussian Blur changes the pixels", async ({ ae, fixture, expect, expectFrame }) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const comp = await project.comp("Main");
  const effect = await (await comp.layer("Solid 1")).effects.apply("ADBE Gaussian Blur 2");

  const before = await comp.renderFrame(0, { subdirectory: "before" });
  await effect.parameter("ADBE Gaussian Blur 2-0001").set(100);
  const after = await comp.renderFrame(0, { subdirectory: "after" });

  expectFrame(after).toHaveSize(before.width, before.height);
  await expectFrame(after).toMatchSnapshot("blurred");
});
```

```bash
npx ae-test specs/blur.spec.mjs
```

> **Alpha, not published yet.** `0.1.0-alpha.0` is a release candidate in
> this repository; it is not on npm. It depends on
> `@ido-bata/ae-a8n@0.1.0-alpha.0`, which is.

## What has been verified, and how

Two different kinds of evidence. They are not interchangeable.

| | What it shows | Where |
| --- | --- | --- |
| **Fake host** (automated) | The runner, fixtures, assertions, snapshots, reports, CLI exit codes and teardown rules, against an in-process model of After Effects. No After Effects involved. | CI on every pull request: 34 tests, the CLI smoke, and `scripts/check-packed-package.js` (the packed tarball installed into an empty project, run through the installed `ae-test`) |
| **macOS, real After Effects** (manual) | The same CLI, without `--fake-host`, driving After Effects 2026 (26.5x89, Japanese UI) on macOS 27 / arm64: a real `.aep`, a built-in effect by match name, parameter write/read, a PNG render, snapshot comparison, teardown | Run by hand on one Mac; not part of CI. Latest: this release's code with `@ido-bata/ae-a8n@0.1.0-alpha.0` from npm, 4/4 passed. History in [docs/verification.md](docs/verification.md) |
| **Windows** | Nothing. ae-test does not run there today: ae-a8n cannot establish that it started After Effects on Windows, and ae-test refuses any session it does not own | — |

A green CI run means the fake host passed. It does not mean After Effects
behaved; only a real-host run says that.

## Install

Once published:

```bash
npm install --save-dev @ido-bata/ae-test@next
```

`@ido-bata/ae-a8n` comes with it (pinned to `0.1.0-alpha.0`). Until then,
from a clone of this repository: `npm ci && npm run build`, and run
`node dist/cli.js`.

Requirements: Node 22 or later (24 to write specs in TypeScript, see below).
For a real host, additionally: macOS, After Effects installed in the default
location, **Settings → Scripting & Expressions → Allow Scripts to Write Files
and Access Network** on, and **After Effects not running** when the suite
starts.

## Writing tests

A spec is an ES module that calls `test()`; the CLI imports it. Specs can be
`.mjs`/`.js`, or `.ts` on a Node that strips types (Node 24 does).

```js
import { test, skip } from "@ido-bata/ae-test";

test("title", async ({ ae, fixture, testInfo, expect, expectFrame }) => { … }, { timeoutMs: 120_000 });
skip("not yet", async () => {});
```

| Context | |
| --- | --- |
| `ae` | An `AfterEffects` session from ae-a8n, launched for this test and quit after it. Everything ae-a8n's API offers: `openProject`, `comp`, `layer`, `effects.apply/get/all`, `parameter(...).set/get`, `renderFrame` |
| `fixture.project(name)` | Absolute path of a project in the projects directory; a missing one fails as a setup error naming what is there |
| `fixture.attach(name, data)` | Write a file into this test's output directory and list it as an artifact |
| `testInfo` | `{ id, title, file, outputDir }` |
| `expect(value)` | `toBe`, `toEqual`, `toMatchObject`, `toBeDefined`, `toBeGreaterThan`, `toBeLessThan`, `toBeCloseTo`, `.not` |
| `expect(promise).rejects()` | Resolves to an expectation on the rejection: `toMatchObject({ name: "EntityNotFoundError", kind: "composition" })` |
| `expectFrame(frame)` | `toHaveSize(w, h)`, `toPath(pattern)`, `await toMatchSnapshot(name)` |

Use **match names** (`ADBE Gaussian Blur 2`, `ADBE Gaussian Blur 2-0001`), not
display names: display names are localised. ae-a8n's skill and README cover
the After Effects side ([ae-a8n](https://www.npmjs.com/package/@ido-bata/ae-a8n)).

**Sessions.** Every test launches After Effects and quits it, so a test pays
a launch (seconds warm; a cold launch has taken up to 171 s). Tests run one
at a time. ae-test only runs against an After Effects it started: if one is
already running, the first test fails at launch with `HostNotOwnedError`,
the rest are `blocked`, and that After Effects is not touched. At the end of a test its edits are discarded —
nothing is ever saved, so fixtures are not modified (checked on the real
host).

**Results.** `passed`, `failed`, `timed-out`, `skipped`, or `blocked`. A test
whose After Effects did not quit is not reported as passed, and once a host
cannot be vouched for the remaining tests are `blocked` instead of being run
into it.

**Snapshots** compare the SHA-256 of the rendered PNG bytes: exact, no
tolerance. Baselines are written by `--update-snapshots` to
`<results-dir>/__snapshots__/<test id>--<name>.sha256`. They live inside the
results directory, so keep that directory (or copy the baselines back into it)
between runs; a missing baseline fails and names the render it would have
recorded. Test ids are derived from the spec's path, so moving a spec renames
its baselines.

## Fixtures

Project files live in `fixtures/` (or `--projects-dir`). A real run needs a
real `.aep` saved by After Effects. The `fixtures/fixture.aep` in this
repository is a placeholder for the fake host — see
[fixtures/README.md](fixtures/README.md) — and `specs/plugin-render.spec.ts`
uses an effect that exists only in the fake host. Run against a real After
Effects unchanged, that spec fails (it is not a real-host spec), which is
the intended outcome.

## Running

```text
ae-test <files...> [options]

  --results-dir <dir>     artifacts, traces, snapshots, report.json (default .ae-test-results)
  --projects-dir <dir>    where .aep fixtures live (default fixtures)
  --timeout <ms>          per-test budget (default 60000)
  --grep <substring>      only tests whose title contains this
  --update-snapshots      record baselines instead of comparing
  --fake-host             use the in-process fake After Effects instead of a real one
```

Exit codes: **0** everything passed or was skipped, **1** something failed or
timed out, **2** the run never happened (no files, a bad flag, a crash before
the first test). The fake host is never used unless `--fake-host` is given;
it comes from `@ido-bata/ae-a8n/testing`, which ae-a8n marks unstable.

Programmatic use: `run({ files, resultsDir, projectsDir, timeoutMs, grep,
updateSnapshots, transport })` resolves to a `RunSummary`; `formatRun` and
`exitCodeFor` turn it into what the CLI prints and returns.

## Getting the results

```text
.ae-test-results/
  report.json                       every result: status, duration, failure, artifacts, cleanup
  __snapshots__/                    baselines (sha256)
  <test id>/
    trace.jsonl                     ae-a8n's record of every operation (op, status, durationMs, args, result/error)
    artifacts/[subdirectory/]*.png  renders
    a8n-session.json, inbox/, outbox/, staging/   the session's request/response envelopes
```

A failure in the console names the last After Effects operations before it,
from the trace. `report.json` lists each artifact with its path, size and
kind (`render`, `trace`, `attachment`). In CI, upload the results directory
as an artifact.

## Developing

```bash
npm ci
npm run build          # specs and tests import ../dist
npm run check          # typecheck, lint, tests
npm run ae-test -- specs/plugin-render.spec.ts --fake-host --update-snapshots
node scripts/check-packed-package.js
```

`@ido-bata/ae-a8n` is pinned to one exact npm version
([docs/dependency-on-ae-a8n.md](docs/dependency-on-ae-a8n.md)).

## Ecosystem

- **ae-a8n** — After Effects automation runtime and API
- **ae-test** — this test runner
- **ae-farm** — remote execution (not started)

## License

MIT
