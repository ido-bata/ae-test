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
npm install --save-dev /path/to/ae-test-0.2.0-beta.1.tgz

npm run test:fake -- --update-snapshots   # record baselines once
npm run test:fake                          # compare
```

`ae-test.config.json` selects `specs/**/*.spec.mjs`, `"host": "fake"`, and
the `fixtures/` projects directory, so bare `ae-test` needs no flags.
Baselines land in `__snapshots__/fake-in-process/` (commit them); results
land in `.ae-test-results/` (do not commit).

`fixtures/fixture.aep` is a placeholder for the fake host — the fake never
reads project bytes. A real run needs a real `.aep` saved by After Effects.

## Real After Effects

Set `"host": "real"` (or run `ae-test --real-host`) and provide:

- a real `.aep` under `fixtures/` containing the composition/layer names
  your spec uses;
- After Effects installed, **not running** when the suite starts;
- **Settings → Scripting & Expressions → Allow Scripts to Write Files and
  Access Network** enabled;
- on AE 26.5+, script-trust approval for the scripts ae-a8n stages — the
  first run may show a modal that must be approved once per location.

Then swap the fake-only effect id (`ADBE Fake Gaussian Blur`) for a real
effect's match name — match names, not display names, because display
names are localised. A cold launch can take minutes; the per-test budget
covers the test body, not the launch.

A fake-host green proves the harness works; only a real-host run is
evidence about After Effects. See the repository's `docs/verification.md`
for what each evidence level means.
