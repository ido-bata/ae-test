# @ido-bata/ae-test

Playwright-like tests for After Effects plugins and scripts. Each test gets a
fresh After Effects session, drives it through
[`@ido-bata/ae-a8n`](https://www.npmjs.com/package/@ido-bata/ae-a8n), asserts
on what came back — values, typed errors, rendered PNGs — and leaves a trace
and the renders behind.

```js
// specs/blur.spec.mjs
import { test } from "@ido-bata/ae-test";

test("Gaussian Blur changes the pixels", async ({ ae, fixture, expectFrame }) => {
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

> **Alpha.** Published under the `next` dist-tag. The API may change between
> alphas, and only macOS has been run against a real After Effects (below).

## What has been verified, and how

Two different kinds of evidence. They are not interchangeable.

| | What it shows | Where |
| --- | --- | --- |
| **Fake host** (automated) | The runner, fixtures, assertions, snapshots, reports, CLI exit codes and teardown rules, against an in-process model of After Effects. No After Effects involved. | CI on every pull request: the unit tests (including a type check of this README's examples against the built types), the CLI smoke, and `scripts/check-packed-package.js` (the packed tarball installed into an empty project, run through the installed `ae-test`) |
| **macOS, real After Effects** (manual) | The same CLI, without `--fake-host`, driving After Effects 2026 (26.5x89, Japanese UI) on macOS 27 / arm64: a real `.aep`, a built-in effect by match name, parameter write/read, a PNG render, snapshot comparison, teardown | Run by hand on one Mac; not part of CI. Latest recorded run: the 0.1.0-alpha.0 code with `@ido-bata/ae-a8n@0.1.0-alpha.0` from npm, 4/4 passed. This branch's code has **not** been re-run on a real host (see [docs/verification.md](docs/verification.md)) |
| **Windows** | Nothing. ae-test does not run there today: ae-a8n cannot establish that it started After Effects on Windows, and ae-test refuses any session it does not own | — |

A green CI run means the fake host passed. It does not mean After Effects
behaved; only a real-host run says that.

## Install

```bash
npm install --save-dev @ido-bata/ae-test@next
```

`@ido-bata/ae-a8n` comes with it, pinned to exactly `0.1.0-alpha.2`.

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
| `ae` | An `AfterEffects` session from ae-a8n, launched for this test and quit after it. Everything ae-a8n's API offers: `openProject`, `comp`, `layer`, `effects.apply/get/all`, `parameter(...).set/get`, `renderFrame`. `openProject` takes an absolute path: pass `fixture.project(name)` |
| `fixture.project(name)` | Absolute path of a project in the projects directory; a missing one fails as a setup error naming what is there |
| `fixture.attach(name, data)` | Write a file into this test's output directory and list it as an artifact |
| `testInfo` | `{ id, title, file, outputDir }` |
| `expect(value)` | `toBe`, `toEqual`, `toMatchObject`, `toBeDefined`, `toBeGreaterThan`, `toBeLessThan`, `toBeCloseTo`, `.not` |
| `expect(promise).rejects()` | Resolves to an expectation on the rejection: `toMatchObject({ name: "EntityNotFoundError", kind: "composition" })` |
| `expectFrame(frame)` | `toHaveSize(w, h)`, `toPath(pattern)`, `await toMatchFrame(other, options?)`, `await toMatchSnapshot(name, options?)` |

**Conformance.** A test can name the ae-devtools capability IDs it is
evidence for, and the strongest claim it may make:

```js
test("opens a project", async ({ ae, fixture }) => { … }, {
  capabilities: ["ae.operation.project.open"],
  conformance: "pass", // or "unsupported" | "refused" | "unknown"
});
```

With `--conformance` (and optionally `--capability-catalog <catalog.json>`),
the run writes `conformance.json`: one immutable record per test with the
capability IDs, platform, AE version, artifact SHA-256s, session facts and a
classification. A fake-host pass is `fake-only`; only a pass on a real host
is `real-host-verified` — and only when a session actually ran *and* its
transport provenance proves it: a pass with no host contact, or with a
transport that cannot be proven real, records `UNKNOWN`. `conformance.host`
is a claim, not evidence: if it disagrees with the observed transport the
record keeps the observed classification and the report is not ok.
`unsupported`, `refused`, `unknown`, `blocked` and `not-run` stay distinct
and never count as verified coverage;
a passing test that only proves one of those records `UNKNOWN`, not `PASS`.
When `conformance.json` is not ok, the CLI exits 1 even if every test
passed — including when a `--grep`/`--capability` filter selected zero
tests, which is never a green run.

When a catalog is supplied, its `compatibility` rows are honoured: a test
whose every declared capability is incompatible with this OS/arch is
reported `blocked` before launch, and each record flags capabilities that
are incompatible with the observed AE version or whose compatibility could
not be evaluated. `--plugin-binary <path>` and `--sdk-binary <path>`
(repeatable) cite plugin/SDK binaries whose SHA-256 lands in the report for
the consumer's same-bytes check, and `summary.matrix` groups the records by
observed OS × AE version.

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

**Static host methods.** A project's own host operations are declared in an
extension module and compiled ahead of time by `ae-a8n`, then reached through
`ae.call`:

```bash
ae-a8n extension build --extension ./host-extension.ts --out ./.ae-a8n/host.generated.js
ae-test specs/plugin-render.spec.ts --host-script ./.ae-a8n/host.generated.js
```

The script is forwarded to `AfterEffects.launch` unchanged; ae-test never
reads, rewrites or evaluates it, and a method the script does not declare is
refused before anything is sent. From the API, pass `hostScript` to `run()`.
`report.json` records the declared methods under `session.extensions`.

**Isolated session.** To run the whole suite as a separate macOS account, run
it through `ae-a8n`:

```bash
ae-a8n test --user <helper-account> -- npx ae-test specs/
```

The suite then runs in that account's session; ae-test's own ownership rule is
unchanged (it still only drives an After Effects it starts), and
`report.json` records the uid and the GUI session's audit id it ran under, so
the evidence says which account produced it. Machine setup for the helper
account is `ae-a8n setup`'s job, not this package's.

**Snapshots** compare the SHA-256 of the rendered PNG bytes by default:
exact, no tolerance. `--update-snapshots` writes baselines to
`<results-dir>/__snapshots__/<test id>--<name>.sha256` plus the baseline PNG
as `<test id>--<name>.png`. They live inside the results directory, so keep
that directory (or copy the baselines back into it) between runs; a missing
baseline fails and names the render it would have recorded. Test ids are
derived from the spec's path, so moving a spec renames its baselines.

When byte-exact comparison is too strict, pass pixel tolerances as the second
argument. The PNGs are decoded to RGBA and compared per channel:

```js
await expectFrame(frame).toMatchSnapshot("main-frame-0", {
  threshold: 8,             // per-channel delta still counted as equal (0-255)
  maxDiffPixels: 12,        // absolute differing-pixel budget
  maxDiffPixelRatio: 0.001, // or a fraction of all pixels, 0-1
});
```

With no `maxDiffPixels` / `maxDiffPixelRatio` budget, any pixel outside
`threshold` fails; `threshold` is a per-channel tolerance, not an
exact-byte comparison. A digest mismatch without these options keeps the
old exact-hash failure. A digest-only
baseline written before image baselines existed needs one
`--update-snapshots` run before tolerances can be used.

`expectFrame(after).toMatchFrame(before, options)` applies the same pixel
comparison directly between two renders, without a stored baseline.

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
  --capability <id>       only tests declaring this capability ID (repeatable)
  --update-snapshots      record baselines instead of comparing
  --fake-host             use the in-process fake After Effects instead of a real one
  --conformance           write conformance.json evidence beside report.json
  --capability-catalog <path>  validate declared capability IDs against ae-devtools catalog.json
  --source-sha <sha>      git SHA of the code under test for the evidence record
  --run-id <id>           conformance run id (default: generated)
  --conformance-out <path>  write conformance evidence to this path instead
  --plugin-binary <path>  plugin binary under test, hashed into the evidence (repeatable)
  --sdk-binary <path>     SDK build artifact under test, hashed into the evidence (repeatable)
```

Exit codes: **0** everything passed or was skipped, **1** something failed,
timed out, or the run proved nothing (empty selection, not-ok conformance
evidence), **2** the run never happened (no files, a bad flag, a crash before
the first test). The fake host is never used unless `--fake-host` is given;
it comes from `@ido-bata/ae-a8n/testing`, which ae-a8n marks unstable.

Programmatic use: `run({ files, resultsDir, projectsDir, timeoutMs, grep,
capabilityFilter, updateSnapshots, transport, conformance })` resolves to a
`RunSummary`; `formatRun` and `exitCodeFor` turn it into what the CLI prints
and returns. `capabilityFilter` keeps only tests that declare at least one of
the listed capability IDs.
`conformance` is `{ host: "fake" | "real", catalogPath?, sourceSha?, runId?,
outPath?, pluginBinaries?, sdkBinaries? }`; `buildConformanceReport` /
`writeConformanceReport` are also exported for consumers that assemble
their own summary.

## Getting the results

```text
.ae-test-results/
  report.json                       every result: status, duration, failure, artifacts, cleanup,
                                    and the session it ran against (uid, audit session id, host
                                    version, declared extension methods, fixture SHA-256s)
  conformance.json                  per-test capability evidence, only with --conformance
  __snapshots__/                    baselines (sha256 digest + PNG)
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
