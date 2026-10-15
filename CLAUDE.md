# ae-test — agent contract

Playwright-like automated testing framework for After Effects plugins and scripts.

Scope authority: `README.md`.
Delivery policy: [`rebuildup/project-init`](https://github.com/rebuildup/project-init) Constitution + current release-driven profile.

## What this repo owns

- the test experience: DSL, fixture lifecycle, timeouts, assertions, snapshots, artifact collection, failure reporting
- the runner and its CLI
- the decision of *what* to assert about a render

## What this repo does not own

- After Effects operations — every one of them comes from `ae-a8n`. Re-implementing an
  operation here is a defect, not a convenience. The fake host is also `ae-a8n`'s; this
  repo only *injects* it.
- remote execution, worker isolation, queueing — `ae-farm`

## The layering rule

```text
ae-test → ae-a8n → After Effects
```

`ae-test` must not reach past `ae-a8n` to the host. If a test needs an operation
`ae-a8n` does not expose, add it there and come back — do not open a bridge
channel from here.

Specs live in `specs/` and import the **built** entry point (`../dist/index.js`), not
`src/`, so they run under plain Node with no TypeScript loader. Build before running
them (`npm run build`); `npm test` and `npm run ae-test` both do.

## Verification taxonomy and evidence levels

| Level | Meaning |
| --- | --- |
| `implemented` | code exists and compiles |
| `automated test` | covered by a green test in CI |
| `fake/mock only` | verified against `ae-a8n`'s fake host, not a real After Effects |
| `verified on real host` | observed running against an installed After Effects |

**Report the level reached.** A suite that goes green against the fake host has
proven the harness works, not that After Effects works. Those are different claims
and the report must not blur them.

The fake host is opt-in and explicit (`--fake-host`). Never make it a silent default:
a suite that quietly stopped exercising the real thing would go green while proving
nothing.

## Writing a test

- Assert on something a real plugin author would recognise. `toMatchSnapshot` on a
  render is the load-bearing assertion; `expect(x).toBe(true)` is not.
- A test that leaves an After Effects process running is worse than a failing test. The
  runner tears down in a `finally`, but do not start side effects the fixture cannot see.
- Use `fixture.attach` to leave notes or inputs behind. They land in the results
  directory with the rest of the evidence.

## Delivery

- `main` = released state. Current integration line: `release-0-1-0`.
- 1 top-level Issue = 1 number-only branch = 1 ticket PR.
- Independent ticket PR targets the release branch; hard dependencies stack.
- Publish and open a **Draft PR** immediately after the first meaningful commit.
- **Merging is a human-authorized side effect.** An agent never merges.

## Toolchain

`mise` is the project-local toolchain frontend; `mise run check` is the local gate.
`ae-a8n` is consumed from npm as one exact version
(`"@ido-bata/ae-a8n": "0.1.0-alpha.0"`), its tarball pinned by integrity in
`package-lock.json`, and CI installs it with `npm ci`. No range, no `file:`
link, no git URL; `test/dependency.test.ts` enforces it. Bump deliberately.
See [`docs/dependency-on-ae-a8n.md`](./docs/dependency-on-ae-a8n.md).

To try an unpublished `ae-a8n` locally, `npm install ../ae-a8n` in a scratch
branch and do not commit the resulting `package.json` / lockfile.

## Secrets

**Infisical is the SoT for application and CI secrets. Not GitHub repository
secrets, and not hardcoded values.**

CI needs no secret today: the only dependency that once needed one (a private
`ae-a8n` checkout) now comes from the public registry.

Do not add a `secrets.*` reference to a workflow here. If a step needs a secret,
it gets it from Infisical at runtime, and the pointer to where it lives is a
variable.
