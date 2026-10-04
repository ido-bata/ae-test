# How `ae-test` gets `ae-a8n` in CI

**This document describes a temporary arrangement.** `ae-test` currently reaches
into the `ae-a8n` source repository during CI, which is weaker than the package
boundary the project is supposed to have. The end state is a registry
dependency, and the steps to get there are at the bottom.

## Why this exists

`ae-a8n` is not published. Until it is, `ae-test` depends on it as
`"@ido-bata/ae-a8n": "file:../ae-a8n"`, which only resolves if a checkout of
`ae-a8n` sits next to this one.

## The problem

`ido-bata/ae-a8n` is a **private** repository, and the `GITHUB_TOKEN` a workflow
gets by default is scoped to the repository the workflow runs in. Pointing
`actions/checkout` at a different private repository with that token returns
404.

## The arrangement

CI uses a **fine-grained personal access token**, supplied as a repository
secret on **this** repository — the one whose workflow uses it.

### Creating the token

On the token owner's account:

- **Resource owner:** `ido-bata`
- **Repository access:** *Only select repositories* → `ae-a8n`
- **Permissions → Repository permissions → Contents:** *Read-only*
- Set an expiry, and put a reminder in the calendar. This token exists to be
  revoked, not to be rotated forever.

The token is deliberately **not** granted access to `ae-test` itself. This
workflow's own checkout uses the default `GITHUB_TOKEN`; the fine-grained token
is used only for the `ae-a8n` checkout step.

### Storing it

`ido-bata/ae-test` → **Settings → Secrets and variables → Actions → New
repository secret**

- Name: `AE_A8N_TOKEN`
- Value: the token

The secret lives on `ae-test` because that is the repository whose workflow
consumes it. The token's *own* access is the narrow thing — restricted to
`ae-a8n`, read-only.

### Optional: pinning the `ae-a8n` commit

By default CI builds `ae-a8n`'s `release-0-1-0` branch, so fixes there reach
this repository without a manual bump. To pin instead, set the repository
*variable* `AE_A8N_REF` to a branch, tag, or commit SHA.

Either way the run records the resolved commit SHA in the job summary, so a
green build is always attributable to the exact `ae-a8n` commit it validated
against.

## The end state

When `ae-a8n` is published:

1. Tag and publish `ae-a8n` (`publish.yml` does this; see its release notes).
2. In `ae-test/package.json`, change
   `"@ido-bata/ae-a8n": "file:../ae-a8n"` to the released version.
3. In `.github/workflows/ci.yml`, delete three steps: *Require a token…*, *Check
   out ae-a8n*, *Record which ae-a8n commit…*, and the `working-directory: ae-a8n`
   build. `npm install` then resolves the package from the registry.
4. Revoke the token and delete the secret. Nothing should still need it.
5. For local development against an unpublished `ae-a8n`, use
   `npm install ../ae-a8n` — documented in the root `CLAUDE.md`.

Steps 3 and 4 are the point. Until both happen, this repository is reaching
across a boundary it claims not to have, and a token exists only to paper over
that.
