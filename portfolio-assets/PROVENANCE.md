# Portfolio assets — provenance

## ae-test-main.png (main image, 1920x1080 PNG)

Composed evidence board rendered from real run artifacts of
`@ido-bata/ae-test@1.2.1` (repo HEAD `aef785cf085e7a430572d804e0d9f231af3933cf`).

- Spec shown: `specs/plugin-render.spec.ts` (lines 1-48, viewport crop).
- Terminal output: real CLI run on 2026-11-25 (macOS arm64, Node v26.13.1):
  `node dist/cli.js specs/plugin-render.spec.ts --results-dir .ae-test-results-portfolio --projects-dir fixtures --fake-host`
  → 4 passed, 0 failed.
- Op trace rows and rendered frames are copied verbatim from that run's
  `.ae-test-results-portfolio/` artifacts (report.json, trace.jsonl,
  `artifacts/*/Main.00000.png`, 64x64 fake-host renders shown pixelated).
- Right column also shows the committed real-host conformance baseline
  (`__snapshots__/conformance/real-host/.../conformance-real-host-scripting-mjs-4--real-gaussian-blur.png`,
  real After Effects 26.5.3 macOS render recorded by the conformance suite).
- Verification level of the pictured run: **fake/mock only** (in-process
  fake host). The real-host snapshot is **verified on real host** evidence
  committed in this repository. No After Effects process was used for the
  pictured run.
- Rights: project-owned assets, MIT license; no third-party or private data.

## ae-test-supplement-real-host-gaussian-blur.png (supplement)

Byte-identical copy of the committed real-host conformance snapshot above
(real AE 26.5.3, macOS arm64, script-invocation transport). 64x64 PNG.
