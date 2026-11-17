# 公開 API・互換性契約

`@ido-bata/ae-test` が第三者プロジェクトへ保証する面と、その versioning 規則の正本。
Issue #36 で確定。実機検証の evidence level は [verification.md](verification.md)、
release 手順は [releasing.md](releasing.md) を参照。

## 公開 surface

consumer が import してよいのは `package.json` の `exports` が指す
`dist/index.js` / `dist/index.d.ts` のみ。CLI は `bin.ae-test`（`dist/cli.js`）。
`dist/` 内の他のファイル、`src/`、内部 module は契約対象外。

機械的な固定: `test/api-surface.test.ts` が runtime export 名（値）の完全一致を
検査し、`scripts/check-packed-package.js` が packed tarball 上で公開する全ての
値・型名を import する `types-check.ts` を `tsc --strict` で compile する。
export の追加は minor、削除・改名・意味変更は breaking。型のみの export も
契約対象であり、packed consumer の compile が後方互換を検査する。

### DSL（spec ファイルが使う）

| 名前 | 役割 |
| --- | --- |
| `test(title, fn, options?)` | テスト登録。`options.capabilities` / `options.timeoutMs` / `options.skip` / `options.conformance` |
| `skip(title, fn, options?)` | skip 登録 |
| `expect(value)` | `toBe` / `toEqual` / `toMatchObject` / `rejects` 等の assertion |
| `expectFrame(frame)` | spec context 経由では `SnapshotStore` 不要。単体 export は `expectFrame(frame, snapshots)` で `SnapshotStore` を取る（通常は context のものを使う） |
| `toMatchObject` | 部分構造一致 assertion |
| `AssertionError`, `AsyncExpectation` | assertion の error 型・awaitable ラッパ |
| `TestContext`, `TestInfo`, `Fixture`, `RenderedFrame` 等の型 | spec が受け取る context の型 |

### Runner / programmatic API

| 名前 | 役割 |
| --- | --- |
| `run(options)` | `RunOptions` で suite を実行し `RunSummary` を返す。`signal` で中断、`teardownTimeoutMs` / `drainTimeoutMs` で teardown・drain の上限を調整できる |
| `loadTestFiles(files)` | spec を import して registry へ登録 |
| `registeredTests`, `clearRegistry`, `setDeclaringFile` | registry 操作（通常は CLI 経由で不要） |
| `countByStatus`, `hasFailures`, `exitCodeFor` | 結果集計・exit code 判定 |
| `formatRun`, `formatResultLine`, `formatFailure`, `formatSummary` | 人間向け出力整形 |
| `SnapshotStore`, `TestFixture`, `HostNotOwnedError`, `TestContextRevokedError` | 上級者向け構築要素・error 型 |
| `AE_TEST_VERSION` | パッケージ version 定数 |
| `DEFAULT_TIMEOUT_MS`, `DEFAULT_RESULTS_DIR`, `DEFAULT_BASELINE_DIR` | 既定値の公開定数 |

### 設定・discovery

`CONFIG_FILE_NAME`（`ae-test.config.json`）、`DEFAULT_SPEC_PATTERNS`、
`loadConfigFile` / `findConfigFile` / `discoverSpecs`、型 `AeTestConfig` /
`AeTestHost` / `LoadedConfig` / `ConfigError`。

### Conformance

`buildConformanceReport` / `writeConformanceReport` / `evaluateCompatibility` /
`environmentBlockReason` / `hostProvenance` / `loadCapabilityCatalog` と
`Conformance*` / `Compatibility*` / `HostProvenance` 型、schema 定数
`CONFORMANCE_REPORT_SCHEMA` / `CONFORMANCE_RECORD_VERSION` /
`CAPABILITY_CATALOG_SCHEMA`、`ConformanceError`。

## 契約対象の形式

以下は consumer が依存してよい形式。変更は schema version を上げるか
breaking change として扱う。

| 対象 | 形式 |
| --- | --- |
| `ae-test.config.json` | `AeTestConfig` の JSON。未知 key・型不一致は exit 2 |
| baseline tree | `<baselineDir>/<environment>/<test id>--<name>.{sha256,png}`。environment key は transport kind +（fake 以外の transport では）OS/arch、さらに host が version を報告した時だけ AE version/build を含み、`[^a-zA-Z0-9._-]` は `-` に潰される。旧 `<resultsDir>/__snapshots__/` は read-only fallback |
| `report.json` | `ae-test.report/v1`。`RunSummary` の JSON serialization。run 中は各 result ごとに `partial: true` 付きで逐次更新され、最終 write で `partial` が外れる。crash 時に残るのは最後の partial snapshot |
| `conformance.json` | `ae-test.conformance/v1`（`--conformance` 時のみ） |
| `<test id>/diffs/*.diff.json` | `ae-test.image-diff/v1`。失敗した画像比較の診断 |
| artifact `kind` | `"render" | "trace" | "attachment" | "diff"` |
| CLI exit code | `0` 全 pass/skip、`1` 失敗・timeout・interrupted・blocked・非 OK conformance・選択 0 件、`2` setup 失敗（発見 0 件・不正 flag/config・起動前 error）、`130` SIGINT/SIGTERM による中断 |

## 実行中の時間制限と中断

- `timeoutMs`（CLI `--timeout` / config / `test()` option）が縛るのは **test body のみ**。session launch と teardown は別の bound を持つ（launch は ae-a8n の transport timeout、teardown は `teardownTimeoutMs`）。
- timeout または中断で body の待機を打ち切っても、body の promise は cancel できない。runner は `drainTimeoutMs`（既定 5000）だけ settle を待ち、それでも未完了なら `failure.bodyStillRunning: true` を記録して teardown へ進む。未完了の操作を再送したり、所有権不明の host を操作したり、session を次テストへ再利用したりはしない。
- test が終端状態（body settle・timeout・失敗・中断）に達すると、その test に渡した handle は **revoked** になる。`context.ae` とそこから得た全ての object（`Project` / `Comp` / `Layer` / `Effect` / `Parameter` 等の derived handle を含む）のプロパティアクセス・呼び出し、`fixture.project` / `fixture.attach`、context の `expectFrame`（取得済みの expectation を含む）は以後 `TestContextRevokedError` を投げ、host・results dir・baseline へ新規の作用を及ぼさない。呼び出しの判定は **method 参照を取得した時点ではなく呼び出した瞬間**に行うため、`const set = parameter.set` のように timeout 前に保持した method も revoke 後は拒否される。`expect` と `testInfo` は test 状態を持たないため revoked 後も使える。timeout/interrupted では drain 開始前に revoke されるため、drain 中に settle する body の残りの呼び出しも拒否される。
- revocation が保証するのは **revoke 判定以降の新規 dispatch の拒否**まで。drain 前に dispatch 済みの op と、revoke 判定前に既に queue されていた継続処理は cancel できず teardown と競合しうる（ae-a8n / transport の責務）。body が await せず残した detached な非同期処理（timer・floating promise）は動き続け、revoked error を処理しない zombie は uncaught exception / unhandled rejection で process を落としうる。**JavaScript の任意の非同期処理を完全に cancel する保証はなく**、zombie が event loop を生かし続ける場合に process を強制終了もしない — 残留 handle は test code の責務として扱う。
- `teardownTimeoutMs` を超えて `session.close()` が応答しない場合、cleanup は `TeardownTimeoutError` として failed になり、後続テストは blocked になる。quit が観測できなかった以上、報告は quit を主張しない。
- `RunOptions.signal`（CLI では SIGINT/SIGTERM）が abort されると、in-flight の test は `interrupted`、未着手の test は `blocked`（理由: run interrupted）になる。launch 中の abort でも launch の決着を待ってから teardown するため、所有者不明の AE は残らない。CLI は中断時に exit 130 を返す。
- spec file の import/登録失敗はその file の `failed` result（`failure.phase: "load"`）になり、他の file の実行は続く。
- `TestResult.status` の `"interrupted"` と `TestFailure.phase` の `"load"` は 0.2.0-beta.2 で追加された。`"blocked"` は host 状態不明に加えて run 中断による未実行も含む。

## Host provenance と証拠分類

`report.json` / `conformance.json` は session の provenance（transport kind、
real host の OS/arch、AE version/build、host script の宣言 method、fixture の
SHA-256、uid/audit session id）を記録する。host ownership の refusal
（`HostNotOwnedError`）は `failure.ownership` に `kind`（`attached` /
`unknown`）・`evidence`・拒否時 `close()` の結果 `quit` / `quitReason`、
close 自体が失敗した時は `closeError` を構造化して残す。`quit` は「session が
host を quit させたか」であり host の生死の証明ではない: `unknown` かつ
`quit: false` は「起動したかもしれない AE が残っている可能性」を意味する。証拠は
`fake-only` / `verified on real host` / `unknown` に分類され、fake host の
green を real host の verified と読み替えてはならない
（[verification.md](verification.md) の taxonomy が正本）。

## 依存ポリシー

- `@ido-bata/ae-a8n` は exact version pin（例 `0.1.0-alpha.2`）。
  `TestContext.ae` の型は ae-a8n の型をそのまま露出するため、ae-a8n の
  breaking change は ae-test の breaking change として扱い、pin 更新と
  同一 release で取り込む。range 指定・`latest` は使わない。
- Node `>=22`、package manager は npm（`package-lock.json`）。

## Semver / release 規則

- `0.x`（alpha/beta）: 公開 surface・形式は上記契約に従うが、beta までは
  breaking change を beta release に集約してよい。各 beta の CHANGELOG に
  migration 情報を記す。
- `1.0.0` 以降: breaking change は major のみ。feature は minor、修正は patch。
  pre-release（`-beta.N` 等）は対応する release に対する前段階で、
  stable と同じ契約を目指すが breaking を含みうる。
- schema version（`ae-test.report/vN` 等）を上げる変更は breaking。
- deprecated 化は minor で予告し、次の major で削除。

## サポート表明

公開が保証する実行環境は、実機 E2E の証拠がある範囲に限定する。

| 環境 | 状態 |
| --- | --- |
| macOS arm64 + After Effects 2026 | 手動実機 run の記録あり（alpha.0 時点。`0.2.0-beta.1` 候補 `db8147c` 以降の beta train は RC での再検証待ち） |
| Windows | **非サポート**。実機証拠なし。Issue #15 の leftover/ownership 問題が残る |
| その他の AE version / OS | 未検証。動作を保証しない |

fake host での CI green は harness の証拠であり、After Effects の動作証明ではない。
