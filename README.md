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

Or configure the project once and let the CLI discover the suite:

```json
// ae-test.config.json
{
  "specs": ["specs/**/*.spec.mjs"],
  "host": "fake",
  "resultsDir": ".ae-test-results",
  "baselineDir": "__snapshots__",
  "projectsDir": "fixtures"
}
```

```bash
npx ae-test          # runs what the config selects, against the fake host
```

> **Pre-releases.** `next` carries beta/alpha builds while the stable line
> moves; `npm install @ido-bata/ae-test` (no tag) always resolves to the
> supported release. Breaking changes are listed in the CHANGELOG, and the
> compatibility contract is [docs/api.md](docs/api.md).

## What has been verified, and how

Two different kinds of evidence. They are not interchangeable.

| | What it shows | Where |
| --- | --- | --- |
| **Fake host** (automated) | The runner, fixtures, assertions, snapshots, reports, CLI exit codes and teardown rules, against an in-process model of After Effects. No After Effects involved. | CI on every pull request: the unit tests (including a type check of this README's examples against the built types), the CLI smoke, and `scripts/check-packed-package.js` (the packed tarball installed into an empty project, run through the installed `ae-test`) |
| **macOS, real After Effects** (manual) | The same CLI, without `--fake-host`, driving After Effects 2026 (26.5x89, Japanese UI) on macOS 27 / arm64: a real `.aep`, a built-in effect by match name, parameter write/read, a PNG render, snapshot comparison, teardown | Run by hand on one Mac; not part of CI. Latest recorded run: the 1.0.0 release candidate as a packed consumer with `@ido-bata/ae-a8n@0.2.0` from npm — snapshot record + compare, 1/1 passed, `quit=true`, no After Effects left running ([docs/verification.md](docs/verification.md) records the exact SHAs and tarball shasums) |
| **Windows** | Nothing. ae-test does not run there today: ae-a8n cannot establish that it started After Effects on Windows, and ae-test refuses any session it does not own | — |

A green CI run means the fake host passed. It does not mean After Effects
behaved; only a real-host run says that.

## Install

```bash
npm install --save-dev @ido-bata/ae-test
```

`@ido-bata/ae-a8n` comes with it, pinned to exactly `0.2.0`.

Requirements: Node 22 or later. TypeScript specs need a Node that strips
types itself — 22.18+ or 24+ (the CLI exits 2 with a clear message on older
22.x); `.mjs`/`.js` specs run on any supported Node. For a real host,
additionally: macOS, After Effects installed in the default
location, **Settings → Scripting & Expressions → Allow Scripts to Write Files
and Access Network** on, and **After Effects not running** when the suite
starts.

A copyable starting project — config, one fake-host spec, a real-host
variant guide — is in [`examples/consumer/`](examples/consumer/README.md).

## Writing tests

A spec is an ES module that calls `test()`; the CLI imports it. Specs can be
`.mjs`/`.js`, or `.ts` on a Node that strips types (22.18+ or 24).

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
| `expectFrame(frame)` | `toHaveSize(w, h)`, `toPath(pattern)`, `await toMatchFrame(other, options?)`, `await toDifferFromFrame(other, options?)`, `await toMatchSnapshot(name, options?)` |

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

Records are per **test**, not per capability: `capabilityIds` declares what
a test is evidence for, and a PASS means the test ran green on that host —
it does not independently prove each declared ID. Capability coverage is
the union of declarations across passing real-host tests; for per-operation
guarantees, split the tests.

When a catalog is supplied, its `compatibility` rows are honoured: a test
whose every declared capability is incompatible with this OS/arch is
reported `blocked` before launch, and each record flags capabilities that
are incompatible with the observed AE version or whose compatibility could
not be evaluated. `--plugin-binary <path>` and `--sdk-binary <path>`
(repeatable) cite plugin/SDK binaries whose SHA-256 lands in the report for
the consumer's same-bytes check, and `summary.matrix` groups the records by
observed OS × AE version.

**Real-host conformance suite.** `conformance/real-host/` is a spec set that
is deliberately not matched by the default `*.spec.*` discovery — it exists
to produce `real-host-verified` conformance evidence on a machine with
After Effects installed, not to run in CI:

```sh
npm ci
npm run build
node dist/cli.js --config conformance/real-host/ae-test.config.json \
  --install-dir "/Applications/Adobe After Effects 2026" \
  --conformance --capability-catalog "<path to ae-devtools catalog.json>" \
  --source-sha "$(git rev-parse HEAD)"
```

Run this from a clean checkout at the candidate SHA so `dist/` and the
recorded `--source-sha` describe the same code; `--capability-catalog`
takes the path to an ae-devtools `catalog.json` on your machine.

It exercises the scripting domain of ae-a8n's built-in dispatch table —
project/comp/layer reads, writes on a disposable untitled project, an effect
parameter round-trip, and renders whose pixels respond to the parameter —
through the same public API a consumer uses. The render baseline is
committed under `__snapshots__/conformance/real-host/` (environment-scoped);
a plain run compares against it. `--update-snapshots` is only for
deliberately recording or replacing that baseline — never as the routine
verification step. Every
test still pays one AE launch, so the suite is four launches, not a smoke
test. SDK/native-plugin capabilities stay upstream-owned (ae-devtools) and
are not claimed here.

The suite lives in this repository only: `conformance/` is not part of the
npm package (`files` ships `dist`, `examples/consumer` and `CHANGELOG.md`),
so it does not exist under `node_modules/@ido-bata/ae-test/` in a consumer
install. It produces ae-test/ae-devtools conformance evidence; it is not a
template for consumer capability claims — consumers write their own specs
against their own capabilities.

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

**Results.** `passed`, `failed`, `timed-out`, `interrupted`, `skipped`, or
`blocked`. A test whose After Effects did not quit is not reported as
passed, and once a host cannot be vouched for the remaining tests are
`blocked` instead of being run into it. `--timeout` bounds the test body;
session launch and teardown have their own bounds, and SIGINT/SIGTERM
interrupts the run cleanly (exit 130) with `report.json` already on disk —
it is rewritten after every test, so a crash still leaves the evidence
collected so far.

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
`<baseline-dir>/<environment>/<test id>--<name>.sha256` plus the baseline PNG
as `<test id>--<name>.png`. `--baseline-dir` defaults to `./__snapshots__` at
the project root — a directory meant to be **committed**, unlike the results
directory — so a clean checkout or a CI workspace finds the same baselines.
A normal run never writes there; only `--update-snapshots` does, and only for
the baselines the run actually compares.

Baselines are grouped per environment so they cannot collide: the key is the
transport kind plus, for a real After Effects, the OS/arch and the host's own
version and build (`script-invocation-darwin-arm64-ae-…`). The in-process fake
host renders identically everywhere, so its namespace is just
`fake-in-process` — a baseline recorded against the fake is never compared
against a real render, and vice versa. Real-host baselines are only portable
to the same OS/arch/AE version; treat them as per-environment evidence, not a
cross-machine contract.

Baselines recorded before 0.2.0-beta lived at
`<results-dir>/__snapshots__/`. They are still read as a fallback, but
nothing is written there any more; re-run once with `--update-snapshots` (or
move the files into the matching `<baseline-dir>/<environment>/`) to migrate.
Test ids are derived from the spec's path, so moving a spec renames its
baselines.

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
`expectFrame(after).toDifferFromFrame(before, options)` is the inverted
assertion: it passes only when the pixels differ beyond the tolerances, so
a change that produces identical output cannot pass by writing to a
different path.

When a pixel comparison fails, the runner leaves the evidence next to the
render under `<test id>/diffs/`: copies of the expected and actual images, a
`*.diff.png` with every diverging pixel marked, and a `*.diff.json` with the
counts, ratio, options and first difference. They are listed in `report.json`
as `diff` artifacts, and the failure message points at the JSON file. A
comparison that cannot run pixel-wise (a size mismatch, an undecodable file)
still leaves the image copies and the JSON record saying why.

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
ae-test [files...|--spec <glob>...] [options]

  --config <file>        project config (default ./ae-test.config.json)
  --spec <glob>          select specs by glob, repeatable (exclusive with files)
  --real-host            real After Effects even when config says "fake"
  --results-dir <dir>     artifacts, traces, report.json (default .ae-test-results)
  --baseline-dir <dir>    snapshot baselines to commit (default ./__snapshots__)
  --projects-dir <dir>    where .aep fixtures live (default fixtures)
  --timeout <ms>          per-test budget (default 60000)
  --grep <substring>      only tests whose title contains this
  --capability <id>       only tests declaring this capability ID (repeatable)
  --update-snapshots      record baselines instead of comparing
  --host-script <file>    host script built by "ae-a8n extension build"
  --install-dir <dir>     explicit After Effects installation directory
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
evidence), **2** the run never happened (no files, a bad flag, a bad config,
a crash before the first test). The fake host is never used unless `--fake-host`
is given or the config says `"host": "fake"`; it comes from
`@ido-bata/ae-a8n/testing`, which ae-a8n marks unstable.

**Project config.** `ae-test.config.json` at the project root (or `--config
<file>`) carries the options you would otherwise repeat: `specs` (glob
patterns), `projectsDir`, `resultsDir`, `baselineDir`, `timeoutMs`, `grep`,
`capabilities`, `host` (`"real"` | `"fake"`), `hostScript`, `installDir` and
`hostEnvironment`. Precedence is per option: **CLI flag > config > default**.
Paths inside the config resolve against the config file's own directory, so
`--config path/to/project/ae-test.config.json` works from anywhere. Unknown
keys and wrong types are setup errors (exit 2), not warnings.

**Spec selection.** Most explicit wins: positional files, then `--spec`
globs (working-directory relative), then `specs` in the config (config-dir
relative), then the defaults `**/*.spec.{ts,js,mjs}` under the project root.
`node_modules` and dot-directories are never searched. A selection that
matches nothing exits 2 — a run that found no tests is never green.

Programmatic use: `run({ files, resultsDir, baselineDir, projectsDir,
timeoutMs, grep, capabilityFilter, updateSnapshots, transport, conformance })`
resolves to a
`RunSummary`; `formatRun` and `exitCodeFor` turn it into what the CLI prints
and returns. `capabilityFilter` keeps only tests that declare at least one of
the listed capability IDs.
`conformance` is `{ host: "fake" | "real", catalogPath?, sourceSha?, runId?,
outPath?, pluginBinaries?, sdkBinaries? }`; `buildConformanceReport` /
`writeConformanceReport` are also exported for consumers that assemble
their own summary. Config file handling is exported too:
`loadConfigFile` / `findConfigFile` / `discoverSpecs` and the `AeTestConfig`
type, for tools that resolve a project the way the CLI does.

## Getting the results

```text
.ae-test-results/
  report.json                       every result: status, duration, failure, artifacts, cleanup,
                                    and the session it ran against (uid, audit session id, host
                                    version, declared extension methods, fixture SHA-256s)
  conformance.json                  per-test capability evidence, only with --conformance
  <test id>/
    trace.jsonl                     ae-a8n's record of every operation (op, status, durationMs, args, result/error)
    artifacts/[subdirectory/]*.png  renders
    diffs/                          failed image comparisons: image copies, diff PNG, JSON diagnostic
    a8n-session.json, inbox/, outbox/, staging/   the session's request/response envelopes
```

Snapshot baselines are not here — they live in `--baseline-dir`
(`./__snapshots__/<environment>/` by default), a tree meant to be committed:

```text
__snapshots__/
  fake-in-process/                  in-process fake host baselines
  script-invocation-darwin-arm64-ae-<version>-<build>/   real-host baselines
    <test id>--<name>.sha256        rendered bytes' digest
    <test id>--<name>.png           the baseline image for pixel comparison
```

A failure in the console names the last After Effects operations before it,
from the trace. `report.json` lists each artifact with its path, size and
kind (`render`, `trace`, `attachment`, `diff`). In CI, upload the results directory
as an artifact.

## Developing

```bash
npm ci
npm run build          # specs and tests import ../dist
npm run check          # typecheck, lint, tests
npm run ae-test -- specs/plugin-render.spec.ts --fake-host   # baselines are committed under __snapshots__/
node scripts/check-packed-package.js
```

`@ido-bata/ae-a8n` is pinned to one exact npm version
([docs/dependency-on-ae-a8n.md](docs/dependency-on-ae-a8n.md)).

The public API surface, file formats, exit codes, versioning rules and the
supported-environment statement are fixed in
[docs/api.md](docs/api.md). Verification evidence levels live in
[docs/verification.md](docs/verification.md); release procedure in
[docs/releasing.md](docs/releasing.md).

## Ecosystem

- **ae-a8n** — After Effects automation runtime and API
- **ae-test** — this test runner
- **ae-farm** — remote execution (not started)

## License

MIT
