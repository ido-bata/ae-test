# Consumer example

A minimal `@ido-bata/ae-test` project. Everything here works against the
fake host with no After Effects installed.

## Try it

```bash
# This example ships inside the package — copy it into your project:
cp -R node_modules/@ido-bata/ae-test/examples/consumer ./my-ae-tests
cd my-ae-tests
npm install --save-dev @ido-bata/ae-test@next
# or, before the version is published:
npm install --save-dev /path/to/ae-test-0.2.0-beta.2.tgz

npm run test:fake -- --update-snapshots   # record baselines once
npm run test:fake                          # compare
```

`ae-test.config.json` selects `specs/**/*.spec.mjs`, `"host": "fake"`, and
the `fixtures/` projects directory, so bare `ae-test` needs no flags.
Baselines land in `__snapshots__/fake-in-process/` (commit them); results
land in `.ae-test-results/` (do not commit).

`fixtures/fixture.aep` is a placeholder for the fake host — the fake never
reads project bytes, and the real-host spec below needs no `.aep` at all.

## Real After Effects

`ae-test.real.config.json` and `real-host/smoke.spec.mjs` are the real-host
lane: one smoke test that builds a disposable comp at run time, applies a
built-in effect, writes and reads back a parameter by match name, renders
the frame before and after, and asserts the pixels actually differ plus a
snapshot. It is deliberately outside `specs/` so the fake suite never picks
it up — a fake-only example must not stand in for real-AE acceptance. The
config file is not named `ae-test.config.json`, so it is only used when
passed explicitly via `--config` (which `npm run test:real` does).

### No fixture file needed

The spec creates its own fixture: `ae.project()` returns the untitled
project After Effects launched with, `createComp` adds comp `Main`, and
`addTextLayer` adds a text layer — text gives the blur high-contrast edges,
so a parameter that reaches the pixels cannot pass as a no-op the way it
could on a uniform solid. Nothing is saved; teardown discards the untitled
project (`session.close({ unsavedChanges: "discard" })`), so the run leaves
no `.aep` and no project state behind. Automating this far was possible
because ae-a8n exposes `project()` / `createComp` / `addTextLayer`; what it
does not expose is `project.save`, which is why no `.aep` fixture is
required at all.

The only unavoidable human work is After Effects' own consent: first-launch
dialogs, the scripting file/network permission, and the script-trust
approval described below.

### Prerequisites

- After Effects installed and **not running** when the suite starts —
  ae-test refuses a host it did not launch. If you used After Effects
  beforehand (e.g. to look at a project), **quit it completely** before
  running the test; a merely-closed project window is not enough, the
  process itself must be gone.
- Edit `installDir` in `ae-test.real.config.json` to the installation to use
  (e.g. `/Applications/Adobe After Effects 2026` vs `… 2027`).
- **Settings → Scripting & Expressions → Allow Scripts to Write Files and
  Access Network** enabled.
- On AE 26.5+, script-trust approval for the scripts ae-a8n stages — the
  first run may show a modal that must be approved once per location.

### Run

```bash
npm run test:real -- --update-snapshots   # record baselines once
npm run test:real                          # compare
```

A cold launch can take minutes; the per-test budget covers the test body,
not the launch.

### Evidence and diagnosis

Each run writes `.ae-test-results/real/`:

- `report.json` — per-test status, `session` facts (`transport` is
  `"script-invocation"` on the real lane, plus uid/asid, AE `version`/`build`,
  and fixture SHA-256s for any `fixture.project` files a test resolved),
  `failure.phase`/`lastOperations`, and `cleanup`.
- `<test id>/trace.jsonl` — every host operation, in order; the last lines
  name where a failure stopped.
- `<test id>/` renders — the PNGs the assertions compared.
- `__snapshots__/real/<environment>/` — committed baselines (commit them);
  `.ae-test-results/` stays uncommitted.

When a real run fails, read in this order: `report.json` →
`failure.ownership` (was the AE refused as not ours?), `failure.phase`
(`launch` vs `body` vs `cleanup`), `lastOperations` and the tail of that
test's `trace.jsonl`, then `cleanup` (did After Effects actually quit?). A
`HostNotOwnedError` means an AE was already running — quit it and rerun; it
is not a test failure.

A fake-host green proves the harness works; only a real-host run is
evidence about After Effects. See the repository's `docs/verification.md`
for what each evidence level means.
