# Releasing to npm

`@ido-bata/ae-test` publishes under the dist-tag the manifest declares:
`next` for a pre-release (`publishConfig.tag: "next"`), `latest` for a
stable version (`publishConfig.tag` unset or `"latest"`).
`scripts/check-release.js` and `scripts/stage-publish.js` enforce the
pairing in both directions — a pre-release never reaches `latest`, and a
stable version never sits on `next` — so `npm install @ido-bata/ae-test`
always means "the supported release".

- `0.1.0-alpha.0` is published **by a person, with 2FA**, from the tarball the
  `publish` workflow built and verified.
- From `0.1.0-alpha.1` on, the workflow **stages** each version with npm
  Trusted Publishing (OIDC, stage-only) and a person **approves** it with 2FA.
  The workflow never publishes, and no npm token exists anywhere.

This is the procedure `@ido-bata/ae-a8n` uses (its `docs/releasing.md`, and
ido-bata/ae-a8n#14 for staging), with the same scripts.

## Release trains and candidates

Versions ship through a release branch, not directly off `main`:

1. **Integration.** `release/<version>` is cut from `main`. Ticket PRs target
   it and land autonomously once their local gates pass (see the delivery
   profile). `main` only moves when a release lands.
2. **Freeze.** When the ticket scope is done, the release branch head is
   frozen at a fixed SHA. From that point only release-blocking fixes land.
3. **Candidate verification.** The complete applicable gate runs at the frozen
   SHA: `npm run check`, `scripts/check-packed-package.js`, and — where the
   supported matrix in [api.md](api.md) has real-host evidence — the real
   After Effects E2E. Fake-host evidence is reported as fake-only; it never
   substitutes for a real-host claim.
4. **Release PR.** `release/<version> -> main` is release-class: it requires
   explicit human approval even when green. This is the boundary between
   autonomous ticket work and a released state.
5. **Publish.** After the merge, the tag/publish flow below applies. Staging
   is automated; approving the staged version with 2FA is a separate explicit
   human act. Nothing publishes without it.

Beta versions collect breaking changes (see the semver rules in
[api.md](api.md)); a stable `1.0.0` candidate freezes the public contract
documented there.

## What stops an accidental or double publish

The repository is public, so GitHub environments with required reviewers
are technically available — but the publish decision deliberately stays in
[`scripts/publish-gate.js`](../scripts/publish-gate.js), tested in
`test/publish-gate.test.ts`, rather than in settings: a gate that lives in
the repository is reviewable, diffable, and identical on every run. Moving
it to an environment is a separate reviewed change. The conditions:

| Condition | Otherwise |
| --- | --- |
| The run is a pushed tag `v<package.json version>` | skip (pull requests, dispatch, branches); fail on a mismatched tag |
| Repository variable `NPM_PUBLISH_VERSION` equals that version exactly | skip — `"true"`, an older version or nothing all mean "not now" |
| The version is not on npm yet | never sent again; if the tagged commit packs to a different tarball than the one on npm, fail |
| The version is not `0.1.0-alpha.0` | fail — that one is published by hand |
| The tagged commit is an ancestor of `main` | fail |
| npm could be asked | fail (when approved) |
| The tarball `stage` uploads has the shasum the gate checked | fail |

So a release takes three separate, deliberate acts — setting the variable to
the exact version, pushing the tag, and approving the staged version with 2FA
on npm — and no one of them publishes anything alone.

[`scripts/check-release.js`](../scripts/check-release.js) also holds the
release surface: a pre-release never goes to `latest` and a stable version
goes nowhere else, `access` is public, provenance is off by decision (see
below), a tag is exactly `v<version>`, and `AE_TEST_VERSION`
equals the package version. Its rules are pinned by
`test/check-release.test.ts`.

**What this does not protect against.** The gate runs inside the workflow.
Someone with write access can edit the workflow on a branch and tag that; the
npm trusted publisher checks the repository and workflow file name, not the
ref. Staging limits the damage — nothing is installable until a person
approves it with 2FA — but there is no server-side approval gate. Now that
the repository is public, an `npm` environment limited to `v*` tags with
required reviewers would add one; that is a decision for the owner, recorded
here so it is not forgotten.

## The tarball is reproducible

`npm pack` of the same commit gives the same bytes on macOS and on the GitHub
runner, with the same npm (11.19.1, pinned in `publish.yml` as
`NPM_CLI_VERSION`). The gate relies on this to check that a tag points at
what was published, and the manual publish below checks it before sending
anything. Measured for the `0.1.0-alpha.0` candidate in the pull request that
added this file (shasum in its description).

## 0.1.0-alpha.0: published by hand

Prerequisites: the `ido-bata` organisation on npmjs.com, your npm account a
member with publish rights, 2FA on, npm 11.19.1 (`npm --version`).

1. The release commit is the `main` head that contains this file. Note its
   sha.
2. Run the `publish` workflow by hand on `main` (Actions → publish → Run
   workflow, or `gh workflow run publish.yml --ref main`). A dispatch never
   sends anything to npm; it verifies, packs, and dry-runs. Its summary
   (**Record the tarball**) gives the commit, shasum and integrity.
3. Download that run's tarball and build the same commit locally; all three
   must agree:

   ```bash
   gh run download <run-id> -n package -D ./release-tarball
   shasum ./release-tarball/ido-bata-ae-test-0.1.0-alpha.0.tgz   # = the summary's shasum

   git switch --detach <main sha> && git status --short           # must be clean
   npm ci && npm run build && npm pack                            # prints the same shasum
   ```

   If any differs, stop: the two builds are not the same thing.
4. Publish the downloaded tarball — the bytes CI verified:

   ```bash
   npm whoami
   npm publish ./release-tarball/ido-bata-ae-test-0.1.0-alpha.0.tgz \
     --tag next --access public --provenance=false
   ```

   npm asks for the 2FA code.
5. Check:

   ```bash
   npm view @ido-bata/ae-test@0.1.0-alpha.0 dist.shasum dist.integrity   # = step 2
   npm view @ido-bata/ae-test dist-tags
   ```

   Expect `next: 0.1.0-alpha.0`. On a package's **first** publish the
   registry also points `latest` at it whatever `--tag` says (ae-a8n shows
   `latest: 0.1.0-alpha.0` today). That cannot be avoided for the first
   version; later alphas go to `next` only, so `latest` stays at
   `0.1.0-alpha.0` until a stable release moves it.
6. Install it as a user would, in an empty directory, and run the fake-host
   smoke from `scripts/check-packed-package.js` against the registry copy
   (or simply `npm i @ido-bata/ae-test@next && npx ae-test --help`).
7. Tag the published commit and push the tag:

   ```bash
   git tag -a v0.1.0-alpha.0 <main sha> -m "0.1.0-alpha.0"
   git push origin v0.1.0-alpha.0
   ```

   The workflow runs, finds the version on npm, checks the commit packs to
   the published shasum, and sends nothing. `NPM_PUBLISH_VERSION` stays
   unset (were it set to `0.1.0-alpha.0`, the gate fails rather than sends).

The tag comes **after** the publish, so the tag always means "this is what is
on npm".

## 0.1.0-alpha.1 and later: staged, then approved with 2FA

The workflow **stages** the verified tarball with `npm stage publish` through
Trusted Publishing, and a maintainer publishes it by approving the staged
version with 2FA ([staged publishing][npm-staged], [`npm stage`][npm-stage]).
An OIDC token cannot approve. The trusted publisher is configured
**stage-only**, so the registry refuses a plain `npm publish` from this
workflow too.

Pinned and checked by [`scripts/stage-publish.js`](../scripts/stage-publish.js)
(tested against a recording registry with the real npm CLI in
`test/stage-publish.test.ts`):

- npm CLI `NPM_CLI_VERSION` (11.19.1), installed in both jobs and compared
  exactly. `npm stage` needs 11.15.0 or later.
- The dist-tag comes from the manifest (`publishConfig.tag`, or `latest`
  when unset), passed explicitly — `next` for a pre-release, `latest` for a
  stable version. `scripts/check-release.js` refuses the wrong pairing in
  both directions. A staged package's tag cannot be changed later.
- The uploaded tarball is the one `verify` built and the gate checked (sha1
  before sending, and again from npm's report).
- A version already on npm is not staged (the gate), and the registry refuses
  a version that is already staged or published.

Steps:

1. A pull request to `main` that bumps `package.json` `version`, the exported
   `AE_TEST_VERSION` constant, and `CHANGELOG.md`. That merge commit is the
   release commit.
2. Trusted publisher, stage-only, with 2FA (npm ≥ 11.15.0):

   ```bash
   npm trust github @ido-bata/ae-test --file publish.yml \
     --repository ido-bata/ae-test --allow-stage-publish
   ```

   (or npmjs.com → package → Settings → Trusted publishing, with only "stage
   publish" allowed). No environment: see above. A configuration not used
   within 2 days expires ([npm][npm-tp]), so do this when the release is
   ready. `repository.url` in `package.json` must match the repository. This
   needs the package to exist, i.e. after `0.1.0-alpha.0`.
3. Repository variable `NPM_PUBLISH_VERSION` = `0.1.0-alpha.1`.
4. Tag the release commit on `main` and push the tag:
   `git tag -a v0.1.0-alpha.1 <sha> -m "0.1.0-alpha.1" && git push origin v0.1.0-alpha.1`.
5. The workflow verifies, the gate approves, `stage` stages. The run summary
   gives the stage id and shasum.
6. Review and approve, with 2FA:

   ```bash
   npm stage view <stage-id>         # version <version>, tag <next|latest>
   npm stage download <stage-id>     # prints the shasum: must equal the run's
   npm stage approve <stage-id>      # 2FA; publishes under that tag
   ```

   If anything is off: `npm stage reject <stage-id>` (2FA). The version
   number stays taken while staged; after a rejection, check
   `npm stage list` before reusing it.
7. Check: `npm view @ido-bata/ae-test@<tag> version` (the tag is `next` for
   a pre-release, `latest` for a stable) and
   `npm view @ido-bata/ae-test@<version> dist.shasum`.
8. Delete `NPM_PUBLISH_VERSION`.
9. Once staging has worked: package Settings → Publishing access →
   **Require two-factor authentication and disallow tokens**.

If `stage` fails after the gate approved, check
`npm stage list @ido-bata/ae-test` before anything else: a version that did
get staged cannot be staged again. Re-run the failed job of that same run; do
not move the tag to another commit — that is a new version.

First exercised for real by `1.0.0` (2026-11-18): tag `v1.0.0` on the
`release/1.0.0 -> main` merge commit staged `@ido-bata/ae-test@1.0.0`
under `latest` with the gate-checked shasum, and a maintainer approved it
with 2FA. `npm view` confirmed `dist.shasum`/`dist.integrity` and
`latest: 1.0.0`; the GitHub Packages mirror ran in the same dispatch.

## GitHub Packages mirror (optional, post-publish)

npmjs.com is the canonical registry. GitHub Packages (`npm.pkg.github.com`)
is an additional mirror so the package appears on the repository's Packages
tab; nothing installs from it by default.

After a version is live on npmjs — i.e. after `npm stage approve` has made
it installable — mirror it with the `sync-github-packages` workflow:

```bash
gh workflow run publish.yml -f github_packages_version=<version>
```

or locally, with a token that has `write:packages` configured for
`npm.pkg.github.com`:

```bash
node scripts/sync-github-packages.js <version>
```

`scripts/sync-github-packages.js` refuses a version that is not on npmjs,
skips one already mirrored with matching `dist.integrity` (safe to re-run;
a divergent copy fails instead of skipping), and publishes the exact
`npm pack` tarball of the npmjs version, so both registries serve identical
bytes. It never runs on tag push and never blocks the npmjs flow. The first
publish links the package to this repository for the Packages tab; check the
linkage once after the first mirror.

## Not here yet

- Provenance: the repository is public now, so npm could attest the
  staged publish ([GitHub changelog][gh-prov] no longer blocks it). It
  stays off by decision — `publishConfig.provenance` is `false` and
  `check-release.js` fails otherwise. Enabling it is its own reviewed
  change (trusted-publisher config plus the manifest flag), not a side
  effect of a version bump.
- A server-side approval gate: an `npm` environment limited to `v*` tags
  with required reviewers is available on a public repository. The publish
  decision currently lives in `publish-gate.js`; moving or duplicating it
  into an environment is a separate reviewed change.

[npm-tp]: https://docs.npmjs.com/trusted-publishers
[npm-staged]: https://docs.npmjs.com/staged-publishing
[npm-stage]: https://docs.npmjs.com/cli/v11/commands/npm-stage
[gh-prov]: https://github.blog/changelog/2023-07-26-publishing-with-npm-provenance-from-private-source-repositories-is-no-longer-supported/
