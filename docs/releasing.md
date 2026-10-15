# Releasing to npm

`@ido-bata/ae-test` is published under the `next` dist-tag.

- `0.1.0-alpha.0` is published **by a person, with 2FA**, from the tarball the
  `publish` workflow built and verified.
- From `0.1.0-alpha.1` on, the workflow **stages** each version with npm
  Trusted Publishing (OIDC, stage-only) and a person **approves** it with 2FA.
  The workflow never publishes, and no npm token exists anywhere.

This is the procedure `@ido-bata/ae-a8n` uses (its `docs/releasing.md`, and
ido-bata/ae-a8n#14 for staging), with the same scripts.

## What stops an accidental or double publish

The repository is private and the organisation is on GitHub Free. On that
plan environments cannot be configured for private repositories
([managing environments][gh-manage]), required reviewers and wait timers need
a public repository on every plan below Enterprise ([environments][gh-env]),
and branch protection and rulesets are unavailable. A workflow that names an
environment that does not exist creates it "with no protection rules", so an
`environment: npm` line would look like a gate without being one. The
workflow names no environment, and the conditions live in
[`scripts/publish-gate.js`](../scripts/publish-gate.js), tested in
`test/publish-gate.test.ts`:

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
release surface: a pre-release never goes to `latest`, `access` is public,
provenance is off, a tag is exactly `v<version>`, and `AE_TEST_VERSION`
equals the package version.

**What this does not protect against.** The gate runs inside the workflow.
Someone with write access can edit the workflow on a branch and tag that; the
npm trusted publisher checks the repository and workflow file name, not the
ref. Staging limits the damage — nothing is installable until a person
approves it with 2FA — but the server-side controls (an `npm` environment
limited to `v*` tags, a tag ruleset, required reviewers) need GitHub Team,
Enterprise, or a public repository. Those are decisions for the owner.

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
- Dist-tag `next`, passed explicitly. A staged package's tag cannot be
  changed later.
- The uploaded tarball is the one `verify` built and the gate checked (sha1
  before sending, and again from npm's report).
- A version already on npm is not staged (the gate), and the registry refuses
  a version that is already staged or published.

Steps:

1. A pull request to `main` that bumps `package.json` `version`,
   `AE_TEST_VERSION` in `src/index.ts` (a test keeps them equal), and
   `CHANGELOG.md`. That merge commit is the release commit.
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
   npm stage view <stage-id>         # version 0.1.0-alpha.1, tag next
   npm stage download <stage-id>     # prints the shasum: must equal the run's
   npm stage approve <stage-id>      # 2FA; publishes to next
   ```

   If anything is off: `npm stage reject <stage-id>` (2FA). The version
   number stays taken while staged; after a rejection, check
   `npm stage list` before reusing it.
7. Check: `npm view @ido-bata/ae-test@next version` and
   `npm view @ido-bata/ae-test@0.1.0-alpha.1 dist.shasum`.
8. Delete `NPM_PUBLISH_VERSION`.
9. Once staging has worked: package Settings → Publishing access →
   **Require two-factor authentication and disallow tokens**.

If `stage` fails after the gate approved, check
`npm stage list @ido-bata/ae-test` before anything else: a version that did
get staged cannot be staged again. Re-run the failed job of that same run; do
not move the tag to another commit — that is a new version.

Not verified before the first real use: staging through OIDC against the
real registry. ae-a8n's first staged release (ido-bata/ae-a8n#14) exercises
it first; ae-test should follow only after that has worked.

## Not here yet

- Provenance: npm does not generate it for private repositories
  ([GitHub changelog][gh-prov]). It goes with making the repository public.
- `repository`, `homepage` and the README's relative links point to the
  private repository, so they are 404 on npmjs.com for everyone outside the
  organisation.

[gh-env]: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
[gh-manage]: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
[npm-tp]: https://docs.npmjs.com/trusted-publishers
[npm-staged]: https://docs.npmjs.com/staged-publishing
[npm-stage]: https://docs.npmjs.com/cli/v11/commands/npm-stage
[gh-prov]: https://github.blog/changelog/2023-07-26-publishing-with-npm-provenance-from-private-source-repositories-is-no-longer-supported/
