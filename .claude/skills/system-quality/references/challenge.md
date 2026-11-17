# 実成果物への違反混入

Node.js 22.18以降で、Skillと一緒に配布されるスクリプトを実行する。

```sh
node <installed-skill>/scripts/challenge.mts <source-directory> <trusted-suite.json>
```

suite例:

```json
{
  "command": ["node", "check.mjs"],
  "timeoutMs": 10000,
  "cases": [
    {
      "id": "forbidden-dependency",
      "expect": "reject",
      "diagnostic": "FORBIDDEN_DEPENDENCY",
      "patches": [{"path": "src/client.js", "before": "from './api.js'", "after": "from './internal.js'"}]
    },
    {
      "id": "valid-refactor",
      "expect": "accept",
      "patches": [{"path": "src/client.js", "before": "const value = 1;", "after": "const value = 2 - 1;"}]
    }
  ]
}
```

`before: null`は存在しないfileの追加。置換は正確に一か所へ一致しなければ失敗する。開始時にsourceを一度凍結し、そのdigestを確認したうえで、baselineと各caseをその凍結copyから作る。各copyのdigestも置換前に確認する。原本は変更しない。baselineが成功した場合だけcaseを実行する。rejectはexit 1と、stdoutまたはstderrのいずれかにある固有診断の完全一致行が必要。両streamを連結して診断を作らない。timeout、signal、別exit、無関係な例外はERROR。acceptはexit 0が必要。suite全体が成功した場合だけexit 0。sourceとsuiteのSHA-256、各caseの結果と出力をJSON Linesで返す。

`.git`、`node_modules`、`.reference`、`.tmp`はコピーしない。依存は隔離環境に事前準備するか、信頼した外部executorの絶対pathをcommandに指定する。対象のsymlinkは拒否する。commandはshell文字列ではなくargv。suiteと検査器は評価対象の候補が勝手に変更できないrevisionから供給する。

コピーはOS sandboxではない。実行するコードはhost権限と環境変数を持つ。未知・敵対的なコードはcredentialのない隔離runtimeで実行する。子processや外部side effectの隔離はruntimeの責務。これを本ツールの保証と報告しない。

caseが拒否された事実は、そのcaseの拒否だけを示す。検査器の完全性、アンチケース集合の完全性、要求充足、最適性を示さない。改善候補には同じ要求検査を適用し、別途改善関係の証拠を確認する。

## 契約変更を候補から独立して検出する

`node <trusted-skill>/scripts/verify-contract.mts <trusted-root> <candidate-root>` はtrusted-rootの `quality-contract.json`（保護する相対file/directoryの配列）を読み、内容・実行bit・追加・削除を比較する。候補側manifestへ置き換えない。変更はexit 1、入力・I/O異常はexit 2、不変はexit 0。契約変更は独立した判断へ渡し、不変というだけで実装の品質を合格にしない。

project-initの `Trusted quality contract` workflowは、dispatchしたrevisionを信頼元、40桁SHAを候補とする。候補コードは実行しない。品質規則を正当に更新するPRはこの比較で変更として検出される。承認した契約を新しいtrusted revisionとして採用する権限は、生成者の自己申告と分離する。

このworkflowは自動的にbranch protectionを設定しない。適用先の受理側が信頼元revisionを選び、契約変更の承認と必要なstatusを強制して初めて独立受理が成立する。任意branchからのdispatch結果や、候補自身が作った成功statusを信頼元にしない。導入PR自身による初期の信頼確立はできない。
