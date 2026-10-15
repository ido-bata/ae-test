# How `ae-test` gets `ae-a8n`

From npm, as one exact published version:

```json
"@ido-bata/ae-a8n": "0.1.0-alpha.0"
```

- **Exact, not a range.** It is a pre-release, and `^0.1.0-alpha.0` would
  accept later alphas that may break the API. Bump on purpose, in its own
  pull request.
- **Pinned by integrity.** `package-lock.json` records the tarball URL on
  registry.npmjs.org and its sha512. CI installs with `npm ci`, which refuses
  a tarball that does not match, and writes the version, URL and integrity
  to the job summary. A green run is attributable to one immutable tarball.
- **No credentials.** Installing a public package needs none, so the job has
  `contents: read` only: no `id-token: write`, no secret, no second
  repository.

`test/dependency.test.ts` fails on a range, a `file:` link, a git URL, a
lockfile entry that does not match the version, or a leftover sibling
checkout entry.

## Bumping

```bash
npm install --save-exact @ido-bata/ae-a8n@<version>
npm run build && npm run check
```

Then run the real-host suite on the Mac before merging, since the fake host
cannot show what changed in After Effects itself.

## Trying an unpublished ae-a8n

`npm install ../ae-a8n` against a sibling checkout (after `npm run build`
there) works for local experiments. Do not commit the resulting
`package.json` or lockfile: the test above fails on purpose. A sibling link
resolves to whatever that checkout's `dist/` holds, so a branch switch over
there silently changes what is tested here — the reason this arrangement
ended.

## History

Until `0.1.0-alpha.0` was published, `ae-test` depended on
`"file:../ae-a8n"`, and CI was to reach the private `ido-bata/ae-a8n`
repository with a fine-grained token held in Infisical and fetched through
GitHub OIDC. That was never set up (decision of 2026-10-15, ido-bata/ae-test
#8): CI stayed red, labelled BLOCKED, until the package was on npm. If any
of it was created anyway, remove it — nothing uses it:

- the `AE_A8N_TOKEN` fine-grained token (revoke on GitHub, delete in
  Infisical);
- the Infisical machine identity for `repo:ido-bata/ae-test:*`;
- the repository variables `INFISICAL_*` and `AE_A8N_REF`.
