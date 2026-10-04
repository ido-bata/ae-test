# How `ae-test` gets `ae-a8n` in CI

**This describes a temporary arrangement.** `ae-test` reaches into the `ae-a8n`
source repository during CI, which is weaker than the package boundary the
project is supposed to have. The end state is a registry dependency, and the
steps to get there are at the bottom.

## Why this exists

`ae-a8n` is not published. Until it is, `ae-test` depends on it as
`"@ido-bata/ae-a8n": "file:../ae-a8n"`, which only resolves if a checkout of
`ae-a8n` sits next to this one.

`ido-bata/ae-a8n` is a **private** repository, and the `GITHUB_TOKEN` a workflow
gets by default is scoped to the repository the workflow runs in. Pointing
`actions/checkout` at a different private repository with that token returns 404.

So this job needs a fine-grained token limited to `ae-a8n`.

## Where the token lives, and why not GitHub

Per the project's secret-management practice (ADR-0023), **Infisical is the SoT
for application and CI secrets**. Not GitHub repository secrets. The control
plane is the self-hosted instance; the CLI is the normal interface.

The workflow therefore holds **no secret at all**. It exchanges a short-lived
GitHub OIDC token for a short-lived Infisical access token, reads one secret,
and uses it for exactly one step:

```text
GitHub Actions
  → GitHub OIDC token (audience: the Infisical identity)
  → Infisical Machine Identity access token   (short-lived)
  → AE_A8N_TOKEN from the configured path
  → actions/checkout of the private ido-bata/ae-a8n
```

`permissions: id-token: write` is granted to the job only because the OIDC
exchange needs it, and `contents: read` otherwise — the default token is still
used for this repository's own checkout.

## What must already exist in Infisical

Three things, all of which a human creates. **None of them is set by this
repository**, and the workflow fails with a named reason when one is missing.

### 1. A Machine Identity configured for OIDC auth

Infisical supports OIDC auth for machine identities: a JWT-based method where the
identity declares which `iss`, `sub`, `aud` it accepts, plus any additional
claims it requires. Configure it so only this repository's `ci` workflow can use
it.

Concrete values, from `ido-bata/ae-test/.github/workflows/ci.yml`:

| Field | Value |
| --- | --- |
| OIDC Discovery URL | `https://token.actions.githubusercontent.com/.well-known/openid-configuration` |
| Issuer | `https://token.actions.githubusercontent.com` |
| Subject | `repo:ido-bata/ae-test:*` |
| Audiences | `ae-test-infisical` — must equal `INFISICAL_OIDC_AUDIENCE` exactly |
| Additional claims | `repository_owner: ido-bata` |
| | `repository: ido-bata/ae-test` |
| | `workflow_ref: ido-bata/ae-test/.github/workflows/ci.yml@*` |

Infisical's `subject`, `audiences`, and `claims` fields all support glob
patterns, so the `@*` above is a real wildcard rather than a literal.

**Use `workflow_ref`, not `job_workflow_ref`.** GitHub's documentation is
explicit that `job_workflow_ref` and `job_workflow_sha` are *"only present for
reusable workflows"* and *"do not appear in normal (non-reusable) workflow
tokens"*. This workflow is a normal one, so that claim would be absent from
every token, the additional-claim check would fail, and **every run would fail**
with a missing-claim error rather than anything diagnosable. `workflow_ref` is
the claim that identifies the workflow file.

The `@*` wildcard is required, not optional: on a `pull_request` event the ref
is the pull request's merge ref, not `refs/heads/main`. An exact value would
pass on pushes to `main` and fail on every pull request.

Two things to be precise about:

- **`sub` is the primary narrowing control.** Without customising the token,
  GitHub sets `sub` to `repo:OWNER/REPO:ref:refs/heads/BRANCH`, so a glob of
  `repo:ido-bata/ae-test:*` restricts this to workflows in this repository. The
  additional claims are belt-and-braces; `workflow_ref` is what narrows it to
  *this one workflow file* rather than any workflow in the repository.
- **The audience is chosen by us**, via `INFISICAL_OIDC_AUDIENCE`. Naming it
  explicitly is what stops the JWT being replayable by another relying party
  asking for a default-audience token.

Least privilege: this identity should have read access to **one project, one
CI environment, one dedicated path** — nothing else in the Infisical org. A
path such as `/ci/ae-test/dependencies` keeps the token clearly separate from
anything else stored for this repository.

### 2. The secret itself

A fine-grained GitHub personal access token, deliberately narrow:

- Resource owner `ido-bata`
- Repository access: only `ae-a8n`
- Contents: **Read-only**
- An expiry, with a reminder in the calendar

Stored in Infisical as `AE_A8N_TOKEN` at the path referenced by
`INFISICAL_SECRET_PATH`, e.g.

```text
/ci/ae-test/dependencies
  AE_A8N_TOKEN=<the fine-grained PAT>
```

Name it on the GitHub side so revoking it later is obvious:
`ae-test-ci-read-ae-a8n`.

### 3. Repository variables on this repository

Set under **Settings → Secrets and variables → Actions → Variables**. These are
**non-secret** pointers; their shape is reviewable in the workflow and none of
them grants access on its own.

| Variable | Example |
| --- | --- |
| `INFISICAL_DOMAIN` | `https://secrets.rebuildup.dev` |
| `INFISICAL_IDENTITY_ID` | the machine identity's id |
| `INFISICAL_PROJECT_ID` | the project holding the secret |
| `INFISICAL_ENVIRONMENT` | `dev` |
| `INFISICAL_SECRET_PATH` | `/ci/ae-test/dependencies` |
| `INFISICAL_OIDC_AUDIENCE` | `ae-test-infisical` |
| `AE_A8N_REF` | *optional* — a branch, tag, or SHA to pin |

By default CI follows `ae-a8n`'s `release-0-1-0`, so its fixes reach here
without a manual bump. Every run records the resolved commit SHA in the job
summary, because a branch name is not an immutable identity and a green build
has to be attributable to the exact commit it validated against.

## Handling rules this workflow follows

- The OIDC exchange response is captured in a variable and **never written to
  disk**, so the access token cannot be read by a later step or left in a temp
  file.
- Both the Infisical access token and `AE_A8N_TOKEN` are `::add-mask::`ed
  before anything could echo them, and nothing above the masking line touches
  either value.
- The token is used by **exactly one step** — the `ae-a8n` checkout.
- The job summary records which identity was used and which `ae-a8n` commit was
  validated. It records no secret values.

## A local failure mode this causes

Observed while reviewing, and worth knowing before it costs someone an hour:

```text
src/fixture.ts(13,29): error TS2305:
  Module '"@ido-bata/ae-a8n"' has no exported member 'HostTransport'.
```

The error names `ae-test` files, but the cause is usually a **sibling checkout on
the wrong `ae-a8n` branch**. `file:../ae-a8n` resolves to whatever `dist/` that
checkout currently holds, and `dist/` is only refreshed by `npm run build` over
there. Switching `ae-a8n` to a branch without the public API makes every
`ae-test` type reference fail at once, pointing away from the real cause.

Before investigating anything in `ae-test`, check:

```bash
git -C ../ae-a8n branch --show-current
npm --prefix ../ae-a8n run build
```

`npm install` here also records the linked package's dev dependencies in this
repository's `package-lock.json`, so the lockfile's contents depend on which
branch the sibling checkout is on. Revertable, and not fatal since CI runs
`npm install` rather than `npm ci` — but it is another symptom.

This is an argument for ending the arrangement, not for it. A registry version
is immutable and named, so it cannot be silently changed by an unrelated branch
switch on a sibling checkout.

## The end state

When `ae-a8n` is published:

1. Tag and publish `ae-a8n` (`publish.yml` does this).
2. In `ae-test/package.json`, change
   `"@ido-bata/ae-a8n": "file:../ae-a8n"` to the released version.
3. In `.github/workflows/ci.yml`, delete: *Check the Infisical pointers are
   configured*, *Authenticate to Infisical with the GitHub OIDC token*, *Check
   out ae-a8n*, *Record which ae-a8n commit…*, and the `working-directory:
   ae-a8n` build. Then drop `id-token: write` — the job no longer needs it.
4. Revoke the `AE_A8N_TOKEN` fine-grained token and delete it from Infisical.
   Nothing should still need it.
5. Delete the `INFISICAL_*` repository variables.
6. For local development against an unpublished `ae-a8n`, use
   `npm install ../ae-a8n` — noted in the root `CLAUDE.md`.

Steps 3 to 5 are the point. Until they happen, this repository reaches across a
boundary it claims not to have, and a machine identity exists only to paper over
that.
