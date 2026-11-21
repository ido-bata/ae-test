# Verification

What has been checked, against what, and what it does not cover. The fake
host and the real host are reported separately on purpose: a pass on one says
nothing about the other.

## Fake host (automated, every pull request)

`.github/workflows/ci.yml`, Ubuntu, no After Effects:

- `npm ci` with `@ido-bata/ae-a8n@0.2.0` from registry.npmjs.org,
  integrity checked against `package-lock.json`, recorded in the job summary;
- build, typecheck, lint, and the unit/contract test suite (runner, fixtures,
  teardown, snapshots and
  pixel-tolerant image comparison, conformance evidence classification,
  transport-provenance host promotion guards, non-ok exit status,
  capability-ID selection, environment compatibility and
  evidence aggregation, the checked-in capability
  manifest, reports, the dependency pin, the version constant, the README
  examples type-checked against `dist`, and the static-host-extension cases —
  those now run, because the pinned version is the first published one with
  the extension API);
- the CLI against `specs/plugin-render.spec.ts` with `--fake-host`, recording
  then comparing snapshots;
- `scripts/check-packed-package.js`: the packed tarball installed into an
  empty project, specs importing `@ido-bata/ae-test` by name run through the
  installed `ae-test` binary; exit codes 0 / 1 / 2, `report.json`, a
  `conformance.json` whose records are all `fake-only`, render and trace
  artifacts.

The fake host is ae-a8n's model of After Effects (`@ido-bata/ae-a8n/testing`).
It knows effects that do not exist in After Effects (`ADBE Fake Gaussian
Blur`) and its renders are not After Effects renders.

## macOS, real After Effects (manual)

One Mac: After Effects 2026 (26.5.3x9, Japanese UI), macOS 27, arm64. Fixture:
a real `.aep` saved by After Effects with comp `Main` and solid `Solid 1`
(sha256 `c00489fe…`). Harness: `p5.mjs` — the `ae-test` CLI, no
`--fake-host`, run twice:

- **A, the shipped spec unchanged.** It names a fake-only effect, so the
  correct result is red: exit 1, with After Effects' own error for the
  effect. Not green is the check.
- **B, the same four tests against a real effect** (`ADBE Gaussian Blur 2`
  by match name): apply, parameter write/read-back, two renders whose bytes
  differ, a typed `EntityNotFoundError`, a snapshot compared against a
  baseline recorded in an earlier session. All four must pass, with a PNG and
  a trace collected per test.

Every run also checks: no modal dialog left in After Effects, After Effects
not left running, and the fixture's bytes unchanged.

A second harness now exists for the same lane (#52): a clean consumer
project installs the packed release tarball and runs `ae-test` with
`installDir` pointed at AE 2026. Its spec needs no `.aep` — it builds a
disposable comp at run time — and asserts on pixels: Gaussian Blur 2
changes the render, a parameter write reaches the pixels, and a snapshot
is recorded then compared on a second run.

A third harness covers the conformance evidence path itself (#112):
`conformance/real-host/scripting.mjs` (repository tooling — not shipped
in the npm package) is not a `*.spec.*` file, so it never
runs in CI or the fake-host lane. Run explicitly with
`--config conformance/real-host/ae-test.config.json --install-dir <AE>` plus
`--conformance --capability-catalog <ae-devtools catalog.json>`; it builds a
disposable comp on the untitled project (no `.aep` needed — the committed
`fixtures/fixture.aep` is a fake-host placeholder) and exercises 29
capability declarations (17 distinct `ae.operation.*` IDs) across project/comp/layer reads, writes,
an effect parameter round-trip and pixel-responsive renders. The render
baseline is committed and environment-scoped: plain runs compare against
it, and `--update-snapshots` is reserved for deliberate re-recording.

Provision the real-host consumer from the spec and config shipped inside
the installed package — `node_modules/@ido-bata/ae-test/examples/consumer/`
— or from a fresh checkout at the freeze SHA. Never reuse a scratch copy
kept across releases: a stale spec still asks for the pre-#60
`fixtures/real-host.aep`, which is no longer a requirement (the spec
builds a disposable comp).

| When (UTC) | ae-test | ae-a8n | Result |
| --- | --- | --- | --- |
| 2026-10-15 05:15–05:48 | 1261f77 (pre-release) | bb4c197, from a checkout | 20 of 20 runs passed (10 with a third-party CEP extension disabled, 10 enabled) |
| 2026-10-15 12:30 | 5d30ef6 (this release) | **0.1.0-alpha.0 from npm** | pass: B 4/4 in 21 s, snapshot matched the earlier baseline (`44c9d3df…`), every session quit; A red as intended |
| 2026-11-11 | 0.1.0-alpha.1 branch | `0.1.0-alpha.2` from npm | **not run.** No real-host row was produced for this branch. The *isolated* lane is blocked on machine setup (`offstage doctor`: "no computeruse account"; `ae-a8n doctor`: `A8N-SESSION-003`, uid 501 is the console uid); the *local* lane was not attempted — it needs one-time human consent in After Effects (see below). See #19 for the isolated-lane task and #52 for the local lane |
| 2026-11-17 02:38 | `7a8efdd` (RC freeze) | `0.1.0-alpha.2` pinned | **failed at launch.** The pin predates ae-a8n #106: After Effects started two same-named processes, ownership stayed `unknown`, and the run failed closed with `HostNotOwnedError` — the designed refusal, not a defect in ae-test. Both instances were left running and quit by hand. See #52 and ae-a8n #105 |
| 2026-11-17 15:51 | `381055f` (pin bump only) | `0.2.0` from npm | **failed in the spec.** Launch, ownership, render and teardown all worked on the real host; `expect(x).toBeDefined()` then failed on a defined value — an inverted matcher in ae-test itself, fixed as #65 |
| 2026-11-17 16:2x | `d80a60c` (release head: ae-a8n `0.2.0` pin + #65) | `0.2.0` from npm | **pass.** Packed consumer, two runs: `--update-snapshots` recorded the baseline, then a plain run matched it. 1/1 each (~7.5 s), `cleanup.status=ok`, `quit=true`, no After Effects process left afterwards. No script-trust dialog appeared in either run |
| 2026-11-18 00:2x–02:0x | `613bba8` / `5885643` / `b2af088` (1.0.0 RC freeze; 差分は docs のみ) | `0.2.0` from npm | **pass.** Same packed-consumer lane on the 1.0.0 tarball at each freeze SHA: two runs each, snapshot recorded then compared, 1/1 each, `cleanup.status=ok`, `quit=true`, no After Effects process left afterwards (AE 26.5.3x9 build 9, uid 501, asid 100021, transport `script-invocation`). Final RC tarball shasum `3dd6b068…` |
| 2026-11-18 04:17 | `afe47cd` / `15bc03a` (final RC freeze; tarball built at `afe47cd`, docs-only commits after) | `0.2.0` from npm | **pass.** Fresh external consumer (`/tmp/ae-test-rc-acceptance`) installed the RC tarball (sha256 recorded as the 40-hex prefix `671ba1e3ea6f3d11ba5561aebaf062c085129a79`) and ran the spec shipped inside the package: two runs — `--update-snapshots` recorded the baseline, then a plain run matched it. 1/1 each (~7.5 s / ~9.8 s), `cleanup.status=ok`, `quit=true`, trace + before/applied/after renders collected, no After Effects process left afterwards (AE 26.5.3x9 build 9, uid 501, asid 100021, transport `script-invocation`). An earlier attempt on the same tarball failed closed twice for environment reasons, not defects: a pre-existing AE process (`HostNotOwnedError`, the designed refusal) and a stale scratch consumer whose pre-#60 spec asked for `fixtures/real-host.aep` |
| 2026-11-18 07:0x | `6da3938` (re-freeze: #98/#104 rulesets fix, #100 `.not.toMatchObject` fix, #102 dead-getter removal; tarball `ido-bata-ae-test-1.0.0.tgz`: **sha1 `78a240287751fa7e7d2cac34675614ec7997d6de`**（npm `dist.shasum` と同一の契約。`publish-gate.js` / `stage-publish.js --expect-shasum` が照合する値）、sha256 `af5eefb5657faa069f76ff4eb18fa09bda615c84c3ca26a5526bd73c395d24cb`、sha512 SRI `sha512-mE135NYLmBFKjQcu651dsIN817GCMiDhnKAO8BCyhTrIP9TQcCVIb8AXPOeTS5tJDtpTdvsVmOtQ34pZekY0EQ==`。tarball は `6da3938` で build し、docs-only commit 後の head で再 pack して sha256 が一致することを確認（同一内容物）) | `0.2.0` from npm | **pass.** Unit/contract suite at this SHA: 20 files / 234 tests pass. Fresh external consumer (`/tmp/ae-test-rc2-acceptance`) installed the new tarball and ran the spec shipped inside the package: fake-host lane `--update-snapshots` then plain run, 1/1 each; real-host lane `ae-test.real.config.json` two runs — `--update-snapshots` recorded the baseline, then a plain run matched it, 1/1 each (~6.7 s / ~4.7 s), `cleanup.status=ok`, `quit=true`, trace + renders collected, no After Effects process left afterwards (AE 26.5.3x9 build 9, uid 501, asid 100021, transport `script-invocation`). An earlier attempt at this SHA failed closed with `HostNotOwnedError` because a pre-existing AE (pid 65693, not started by ae-test) was running — the designed refusal, left untouched; the pass rows above it are **not** carried over as evidence for `6da3938` |
| 2026-11-18 09:5x | `1af3fd4` (re-freeze 2: #106 ocr review fixes — publish.yml injection, sync-github-packages guards, conformance evidence correctness, toMatchObject deep compare; tarball `ido-bata-ae-test-1.0.0.tgz`: **sha1 `25757a0f94abf5df62e4042f32581c2a618b4f78`**（npm `dist.shasum` 契約）、sha256 `525434a6e36917df26601392ba71011e1229af618715ee120c3e9bf3f0f11281`、sha512 SRI `sha512-MhHqOuVSzIyKwSUGn1DrcRHWRxsgoV/VvO9HhDOSb0ESKltlVhR5oBnCs+v82U/wQ+Y+IXHvDK9Stwf3Hnuldg==`） | `0.2.0` from npm | **pass.** `npm run check`: 241 tests / 20 files。Fresh external consumer（`/tmp/ae-test-rc3-acceptance`）が新 tarball を install し package 同梱 spec を実行: fake host record→compare 1/1 each、real host `ae-test.real.config.json` record→compare 2 run 1/1 each（~6.6 s / ~4.7 s）、`cleanup.status=ok`、`quit=true`、AE 残存なし（AE 26.5.3x9 build 9、uid 501、asid 100021、transport `script-invocation`、`session.launched=true`）。`6da3938` の pass は本 SHA の証拠として流用していない |
| 2026-11-18 10:4x | `ec722b8` (`release/1.0.0 -> main` merge; tag `v1.0.0`) | `0.2.0` from npm | **published `1.0.0` to npm.** Staged via OIDC (stage id `434aeee0-…`, tag `latest`), approved with 2FA. Registry check: `dist.shasum` `25757a0f94abf5df62e4042f32581c2a618b4f78` and `dist.integrity` `sha512-MhHqOuVSzIyKwSUGn1DrcRHWRxsgoV/VvO9HhDOSb0ESKltlVhR5oBnCs+v82U/wQ+Y+IXHvDK9Stwf3Hnuldg==` match the frozen tarball; `dist-tags`: `latest: 1.0.0`, `next: 0.2.0-beta.2`. Fresh `npm install @ido-bata/ae-test@1.0.0` consumer ran the shipped example spec against the fake host: record → compare 1/1 each. GitHub Packages mirror published the same version in workflow run 44288244482 |
| 2026-11-18 11:5x | `a42a62a` (#112 branch; suite + `--install-dir`) | `0.2.0` from npm | **pass.** `conformance/real-host/` suite on AE 2026 via `--install-dir`: `--update-snapshots` run recorded the baseline, then a plain `--conformance` run at the same SHA compared it — 4/4 pass both times (~21–24 s total, one AE launch per test), all 4 conformance records `real-host-verified`/`PASS` covering 29 capability declarations across 17 distinct `ae.operation.*` IDs, `cleanup.status=ok`, `quit=true`, no After Effects process left afterwards (AE 26.5.3x9 build 9, uid 501, transport `script-invocation`). An earlier attempt failed closed with `HostNotOwnedError` while user-owned AE instances were running — the designed refusal. Two intermediate failures were spec bugs fixed before the pass: a `**/` sequence inside a doc comment terminated the block comment, and the suite originally targeted `fixtures/fixture.aep`, which is a 12-byte fake-host placeholder, not a real project — the suite now builds a disposable comp like the consumer smoke spec |
| 2026-11-18 12:4x | `0b70b52` (1.1.0 RC freeze: #113 evidence fixes + #112 real-host suite/`--install-dir` + #116 version/CHANGELOG + #117 evidence-granularity docs) | `0.2.0` from npm | **pass.** `npm run check`: 243 tests / 20 files green at the freeze SHA. `npm pack` tarball `ido-bata-ae-test-1.1.0.tgz`: sha1 `f7188c07693f388dbe61ccce71aa1b42b95249d5`（npm `dist.shasum` 契約）、sha256 `aeaf421aa4199f9af5b6fb903fa832ee3386b3aa36a91327c2360e88cd437547`、sha512 SRI `sha512-rblNVOTP3Ce9qJQrJPPpzNmou1i4u76061W3JJo1bFpWglhV62ggY0KShr8DTc6KOhQG5CXs85QVYnqL4yFNuw==`、45 files。`conformance/real-host/` は tarball に含まれないことを `tar -tzf` で確認（repo-only tooling、README/CHANGELOG 明記）。`check-packed-package.js`: packed tarball install → fake-host exit 0/1/2・report・conformance `fake-only`・examples/consumer green。Fresh external consumer（`/tmp/ae-test-110-acceptance`）が tarball を install: fake `--update-snapshots`→plain 各 1/1、real `ae-test.real.config.json` `--update-snapshots`→plain 各 1/1（~4.5–4.8 s/run）、`cleanup.status=ok`、`quit=true`、AE 残存なし（AE 26.5.3x9 build 9、uid 501、transport `script-invocation`）。`conformance/real-host/` suite を freeze SHA で `--conformance` 実行: 4/4 pass、全 record `real-host-verified`/`PASS`（29 capability declarations）、`conformance.json` ok。timeout/中断/ownership/cleanup の安全性は 243-test suite（#113 回帰含む）で担保。未検証: Windows・AE 2027・isolated lane（#19）・SDK native（#21 upstream待ち） |
| 2026-11-18 22:1x | `0e43b34` (re-freeze 2: #121 RC review fixes — matrix JSON tuple、teardown-safe artifact collection、`--install-dir` operand 検証、capability ID 修正 `comp.get-layer`、TEXT font 明示、docs 整合; baseline PNG は `0e43b34` で再記録) | `0.2.0` from npm | **pass.** `npm run check`: 245 tests / 21 files green（`c442b43` と tree 同一、baseline/docs commit のみ差分）。`npm pack` tarball: sha1 `84a173aa35ec8f0a978e2c8642deb66cb4ee114f`（npm `dist.shasum` 契約）、sha256 `339b3ca33928d232e60818896804401aa1c3672805c10f9673e7d196b63cd777`、sha512 SRI `sha512-oiTNlQ8wqzgP0R1PJeGrLNaXEZEbtmQPnhBq29bSh7H5CHl1ykel7XTzTROxtST9or02q5/5VIBwOtLVnQdvMw==`、45 files。`0e43b34` で再 pack して sha256 一致を確認（baseline/docs は `files` 対象外、同一内容物）。`check-packed-package.js` green。Fresh external consumer（`/tmp/ae-test-110-acceptance`、新 tarball install）: fake `--update-snapshots`→plain 各 1/1、real `ae-test.real.config.json` `--update-snapshots`→plain 各 1/1（~5.3 s/run）、`cleanup.status=ok`、`quit=true`、AE 残存なし（AE 26.5.3x9 build 9、uid 501、transport `script-invocation`）。`conformance/real-host/` suite を freeze SHA `0e43b34` で実行: `--update-snapshots` で font 変更後の baseline を再記録（commit `0e43b34`）→ plain `--conformance` run で committed baseline と比較し **4/4 pass**（~21 s、1 launch/test）、全 record `real-host-verified`/`PASS`、`conformance.json` ok。`0b70b52` の証拠は本 SHA の証拠として流用していない。未検証: Windows・AE 2027・isolated lane（#19）・SDK native（#21 upstream待ち）。次リリース繰越: snapshot baseline ownership 永続化・case-insensitive alias・store 横断 `--` 衝突・stale render artifacts（#121、#120 review で deferral 合意） |
| 2026-11-21 01:5x–02:0x JST | `3e55d21`（release/1.2.0 head） | `0.2.0` from npm | **pass。** device-windows（Windows 11 10.0.29708 x64、Node v26.13.1）、AE 2026 26.5.3x9 build 9（`D:\4_apps\adobe`）。fresh consumer（`C:\Users\rebui\ae-test-acceptance\consumer`）が packed tarball `ido-bata-ae-test-1.2.0.tgz`（sha1 `bc777f1a8fa30d09b9061140a3aec01ad96ac1d1`、sha256 `3a8aba84fa5013f559c04e8c077fd77190604b7ff3468f57da9d713c08e33d80`、sha512 SRI `sha512-/KZF97FDVK2ZTZsLsP74qCfnIasDCtqTX61k91LZ5crZ25TXzmK+eez6dLxstyBS+BASJXLKdGwhgbWo7S2scA==`、45 files、git `3e55d21` で `npm pack`）を install し、package 同梱 `examples/consumer` spec + `ae-test.real.config.json`（`installDir` を Windows path に変更）で実機 run: `--update-snapshots` record → plain compare → さらに foreign AE 2027 プロセス起動中の 3 回目も compare pass。各 run 1/1（~21–64 s）、`cleanup.status=ok`、`quit=true`、trace + before/applied/after renders 収集、AfterFX 残留なし。session: `launched=true`、`uid`/`asid`=null（Windows）、host `26.5.3x9` build `9`、transport `script-invocation`。baseline は environment-scoped `script-invocation-win32-x64-ae-26.5.3x9-9` に記録（consumer 側・repo 非コミット）。**訂正（#136、同日後刻の trace 照合）**: 「foreign AE 2027 プロセス起動中の 3 回目」は記録誤り。run 3（16:54:15–16:54:35Z）の `trace.jsonl` は launch 時・close 時ともに `AfterFX.exe` が 1 プロセスのみ（"pid 9924 is still the only instance" → `ownership: owned`）であり、census が全 `AfterFX.exe` を数える以上、foreign AE 2027 は run 中に存在しなかった。**ownership は installDir 単位ではない**: Windows の census（ae-a8n `windowsProcesses`）は path を問わず全 `AfterFX.exe` を数えるため、launch 時点で foreign `AfterFX.exe` が 1 つでもいれば owned session は確立できない（#134 / PR #135 の 2026-11-21 07:5x の試行で `HostNotOwnedError` を実測）。isolated lane（`ae-a8n test --user`）・AE 2027・ARM64 Windows は未検証 |
| 2026-11-21 01:4x–02:2x JST | `3e55d21`（release/1.2.0 head。suite は repo tooling で tarball 非含有） | `0.2.0` from npm | **pass（baseline 記録 + compare の 2 run）。** device-windows（Windows 11 10.0.29708 x64、Node v26.13.1）、AE 2026 26.5.3x9 build 9（`D:\4_apps\adobe`、installDir 明示）。`conformance/real-host/` suite を `--conformance --capability-catalog <ae-devtools catalog.json @ d3d332e>` で実行: `--update-snapshots` が win32 baseline（`script-invocation-win32-x64-ae-26.5.3x9-9`、本 commit で追加）を記録 → plain run が committed baseline と比較し **4/4 pass**（各 ~19–22 s、1 launch/test）、全 record `real-host-verified`/`PASS`（29 capability declarations / 17 distinct `ae.operation.*` IDs）、`conformance.json` ok、`cleanup.status=ok`、`quit=true`、AfterFX 残留 0。**実機で観測した失敗経路（すべて設計通り fail-closed）**: (a) 別 AE instance 既存時は `HostNotOwnedError`（kind `attached`、pid 明示）で起動拒否・未接触; (b) test 中に foreign AE 2027 が起動すると teardown が `HostLeftRunning`（"not quitting a host this session does not own (2 instances running)"）で quit を拒否し後続 test を block; (c) 起動した pid が test 中に消失した場合も `HostLeftRunning`（"pid … is gone; 0 other instance(s)"）; (d) 1 回だけ AE が test 途中で終了し 120 s budget timeout → 再実行で pass（AE 側の一過性事象、Application Error log に新規 crash 記録なし。要観察）。TESTCAP03 の refused/cleanup 分類を実機で確認。SDK native plug-in lifecycle は upstream 未整備で依然 BLOCKED。ae-a8n attach-only API（#269, release-0-5-0, 未 publish）には未搭載 — pin は `0.2.0` のまま |
| 2026-11-21 09:2x–09:3x JST | `cd7fb63`（release/1.2.1 head） | `0.2.0` pin の consumer（`@ido-bata/ae-test@1.2.0` tarball install）に ae-a8n `0.5.0` candidate tarball（ae-a8n `origin/main` `444665c` 由来、npm 未 publish）を node_modules 差し替えで適用 | **fail（設計通り fail-closed、real-host evidence なし）。** device-windows、`installDir` = AE 2026 `D:\4_apps\adobe`。`npm run test:real`（consumer `real-host/smoke.spec.mjs`）実行時、foreign `AfterFX.exe` が複数常駐（検証用の偽 `AfterFX.exe` 2 process + `ae-a8n-verify/issue276` の別検証が起動した実 AE 2026 1 process、計 3）。Windows census は全 `AfterFX.exe` を数えるため preexisting 判定となるが、foreign instance が readiness probe に応答しなかったため ownership 分類（`attached`→`HostNotOwnedError`）に到達せず、spawn した AE 2026（pid 46580）が 180 s で `HostUnavailableError`（"no script was sent"）。foreign process は全て未接触・残留。併せて #136 の trace 照合で 01:5x–02:0x 行の「foreign AE 2027 起動中」記述が誤りと確定（run 3 の session 全期間で `AfterFX.exe` は owned の 1 process のみ）。`attached` refusal 経路自体は #134 / PR #135 の 07:5x 試行（vidc pipeline の AE 2027 pid 52192 常駐 → `HostNotOwnedError` "already running before launch"）で実測済み |

Hash naming in this table: bare `shasum`/64-hex values are SHA-256. The npm
publication contract is different — registry `dist.shasum` is SHA-1 and
`dist.integrity` is SHA-512 SRI; `scripts/publish-gate.js` computes SHA-1 and
`scripts/stage-publish.js --expect-shasum` enforces it. The current
candidate's SHA-1/SHA-256/SHA-512 are recorded in the `1af3fd4` row.
Commits after `1af3fd4` (`b429d11` docs, `e317f29` release-tooling + docs
via #108/#109) do not touch `files` in package.json (`dist`,
`examples/consumer`, `CHANGELOG.md`): `npm pack` at `e317f29` reproduces the
same sha1 `25757a0f…` / sha256 `525434a6…`, so the `1af3fd4` evidence —
including the real-host runs — carries to the merged release unchanged.

### Local console-session lane

A real-host run does not have to use the isolated lane: the rows above were
produced by running the `ae-test` CLI directly on the console desktop,
letting ae-test launch and own its own After Effects (`installDir` selects
which installation, e.g. AE 2026 over AE 2027). The packed-consumer variant
of the same lane is what #52 verifies: a third-party-shaped project installs
the release tarball and drives a real After Effects through the public API.

The human cost is consent, not code: first-launch dialogs, the scripting
file/network permission, and — when AE asks — the script-trust approval
whose granularity is still open upstream (ae-a8n #125). On 2026-11-17/18 the
two smoke runs completed without any script-trust dialog; that is two
observations on one machine and one consumer, not a general answer.
`A8N-SESSION-003` is a refusal of the *isolated* lane only — it says nothing
about the local one.

### Isolated session (not yet run at all)

`ae-a8n test --user <helper> -- npx ae-test …` is the intended shape for a
real-host run that does not use the console desktop. It is unimplemented
evidence-wise here: the helper account on this Mac has never been logged in
(`offstage session status --user test`: "none, nothing is logged in under that
account"), and the machine setup it needs — fast-user-switch login, TCC
grants, AE scripting permission, one Adobe sign-in in that session — is human
work by design (`ae-a8n setup` will not do it, and nothing here creates an
account). Until that exists, the only macOS real-host evidence remains the
console-session rows above.

`report.json` records `uid`, the GUI session's `asid` (read with
`launchctl print gui/<uid>` on macOS), the host's `version`/`build`, the
declared extension methods and the SHA-256 of every project fixture a test
resolved. The 2026-11-17 consumer runs observed these on a real host:
uid 501, asid 100021, After Effects 26.5.3x9 (build 9), transport
`script-invocation`.

Evidence (proof.json, report.json, traces, renders, a sha256 manifest) is kept
outside the repository, in the project's evidence store
(`_evidence/2026-10-15-ae-a8n-macos-real-host/`,
`_evidence/2026-11-18-beta2-real-host/`).

### Not covered

- Windows: partially covered. The packed consumer smoke spec and the
  `conformance/real-host/` scripting suite pass on Windows 11 x64 with AE
  2026 (26.5.3x9, build 9) — see the 2026-11-21 rows. Still unverified:
  the isolated session lane, AE 2027, ARM64 Windows, non-English UI, and
  SDK native plug-ins. Earlier notes saying "ae-a8n reports ownership
  `unknown` on Windows" are stale: with `installDir` selecting a single
  installation, ae-a8n establishes `owned` sessions on Windows and ae-test
  runs against them — but only while no other `AfterFX.exe` exists.
  On Windows the launch-time census counts **every** `AfterFX.exe`
  regardless of installDir or path (unlike macOS, where it is scoped to
  the install's executable and uid), so any foreign After Effects already
  running makes the session `attached`/refused rather than `owned`
  (#136). `installDir` selects which installation is launched and quit;
  it does not scope the census.
- Third-party plugins: only After Effects' built-in Gaussian Blur.
- Long suites: at most four tests per run; one launch and quit per test.
- Known After Effects-side risks are ae-a8n's, listed in its README: a
  third-party extension's modal alert during a long script, one stall at quit
  (not reproduced in 20 runs), a cold launch close to the 180 s readiness
  budget.
