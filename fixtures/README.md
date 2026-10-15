# Test fixtures

Project fixtures consumed by `fixture.project(name)`.

## `fixture.aep`

**This file is a placeholder, not a real After Effects project.**

It exists so the `ae-test` runner and the `ae-a8n` bridge have a path to open
when running against the in-repo fake host. A real `.aep` is a binary format
that only After Effects can write, and After Effects is not installed in this
environment.

To run these specs against a real After Effects, replace this file with a real
project exported from AE containing:

- a composition named `Main`
- a solid layer named `Solid 1`

The specs assume nothing else about the project beyond those two names, so any
project with that shape works.

## Effect identifiers

The specs apply `ADBE Fake Gaussian Blur`, an effect that exists **only in the
fake host** (`ae-a8n`'s `FAKE_EFFECTS`). Against a real After Effects, swap the
identifier for a genuine plugin's match name — the point of the vertical slice
is the path through the bridge, and that path is identifier-agnostic.
