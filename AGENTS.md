# ae-test — agent contract

Playwright-like automated testing framework for After Effects plugins and scripts.

Scope authority: `README.md`.
Delivery policy: [`rebuildup/project-init`](https://github.com/rebuildup/project-init) Constitution + current release-driven profile.

## Canonical sources

- 最上位 contract: [`constitution/CONSTITUTION.md`](constitution/CONSTITUTION.md)
- 現在の Operating Model: [`organization/profiles/release-driven-solo.md`](organization/profiles/release-driven-solo.md)
- release 手順: [`docs/releasing.md`](docs/releasing.md)
- ae-a8n 依存の判断: [`docs/dependency-on-ae-a8n.md`](docs/dependency-on-ae-a8n.md)
- 検証 evidence level: [`docs/verification.md`](docs/verification.md)
- Agent Skills（進捗的開示）: `.agents/skills/`（`skills-lock.json` が導入元と hash を記録）

このファイルは dispatcher であり、詳細は各正本と Skill への pointer に置く。毎回全 skill を読まない。

## What this repo owns

- the test experience: DSL, fixture lifecycle, timeouts
- assertions, snapshots, artifact collection, failure reporting
- the runner and its CLI
- the decision of *what* to assert about a render

## What this repo does not own

- After Effects operations — every one of them comes from `@ido-bata/ae-a8n`. The fake host is also `ae-a8n`'s; this repo only *injects* it.
- remote execution, worker isolation, queueing — `ae-farm`

The layering rule: `ae-test → ae-a8n → After Effects`. Do not reach past `ae-a8n` to the host. If a test needs an operation `ae-a8n` does not expose, add it there and come back — do not open a bridge channel from here.

## Specs and build

- Specs live in `specs/` and import the **built** entry point (`../dist/index.js`), not `src/`, so they run under plain Node with no TypeScript loader. Build before running them (`npm run build`); `npm test` and `npm run ae-test` both do.
- The fake host is opt-in and explicit (`--fake-host`). Never make it a silent default: a suite that quietly stopped exercising the real thing would go green while proving nothing.

## Delivery

- `main` = released state. The current integration line is the open `release/*` branch (currently `release/1.3.0`); independent ticket PRs target that release branch while it is unfrozen. Once a release branch is frozen at a candidate SHA, only release-blocking fixes land — non-blocking tickets wait for the next release line. `release/* -> main` PRs are release-class.
- 1 top-level Issue = 1 number-only branch = 1 ticket PR.
- Publish the branch and open a **Draft PR** immediately after the first meaningful commit.
- PR landing is **merge commit only** (squash/rebase disabled at the repository level).
- Ticket PRs that satisfy the readiness/quality gate land autonomously in dependency order without additional user merge authorization. `release/* -> main` landing and npm publish remain explicit human-authorized side effects; an agent does not perform them.

## Toolchain

`mise` is the project-local toolchain frontend. `mise install` to bootstrap;
`mise run check` (typecheck / lint / test) is the local quality gate.
`mise` is not an isolation boundary — do not treat it as one.

Package manager は **npm**（`package-lock.json`、CI は `npm ci`）。組織共通ルールの Bun 既定からの deviation であり、lockfile integrity と `npm ci` の再現性を優先する。移行する場合は lockfile・CI・docs をまとめて変更する別 ticket とする。

Worktree を使う場合、作成・削除は必ず `mise run worktree:setup` / `mise run worktree:teardown` を通す（`.config/wt.toml` が Worktrunk hook として配線済み。plain `git worktree` でも同じ入口を手で呼ぶ）。詳細は `worktree-workflow` Skill。

## Verification taxonomy and evidence levels

| Level | Meaning |
| --- | --- |
| `implemented` | code exists and compiles |
| `automated test` | covered by a green test in CI |
| `fake/mock only` | verified against `ae-a8n`'s fake host, not a real After Effects |
| `verified on real host` | observed running against an installed After Effects |

**Report the level reached.** A suite that goes green against the fake host has proven the harness works, not that After Effects works. Those are different claims and the report must not blur them.

## Writing a test

- Assert on something a real plugin author would recognise. `toMatchSnapshot` on a render is the load-bearing assertion; `expect(x).toBe(true)` is not.
- A test that leaves an After Effects process running is worse than a failing test. The runner tears down in a `finally`, but do not start side effects the fixture cannot see.
- Use `fixture.attach` to leave notes or inputs behind. They land in the results directory with the rest of the evidence.

## Agent Skills — 能力ごとの担当

Skill の実体は `.agents/skills/<name>/SKILL.md`（agent 別 directory へ同一 copy）。`disable-model-invocation` のものは自動起動しないので、該当場面では下の path を直接読む。

| 能力 | 担当 Skill | 使う場面 |
| --- | --- | --- |
| delivery | `github-delivery` | Issue / branch / PR / release の進め方 |
| recovery | `agent-recovery` | 中断・crash からの復旧、checkpoint、外部 side effect |
| orchestration | `parallel-orchestration` | worker への分解・委譲・immutable snapshot/result |
| execution-isolation | `sandbox-runtime` | worker ごとの独立 runtime が必要な並行作業 |
| workspace-lifecycle | `worktree-workflow` | worktree の作成・切替・削除と cache |
| supervisor-runtime | `herdr-runtime` | Herdr を Supervisor runtime として使う時だけ |
| quality-gate | `quality-gate` | verification level・gate・CI の設計と実行 |
| design-before-build | `design-refinement` | 非自明な feature / architecture / product design の実装前整理 |
| engineering-decisions | `engineering-decisions` | 実装判断の優先順位と user escalation の境界 |
| debugging | `diagnosing-bugs` | 再現できる失敗・性能退行の診断 loop |
| tdd（手動） | `tdd` — `.agents/skills/tdd/SKILL.md` | user が明示した時、または安い局所 test target がある bug fix のみ |
| code-review | `code-review` | fixed point からの diff を Standards / Spec の2軸でレビュー |
| correctness | `correctness-assurance` | runner / fixture / teardown 等の重要な不変条件の保証設計 |
| system-quality | `system-quality` | 要求変更・初期化・設計再構成での全体品質改善 |
| code-naming | `code-naming` | 命名・リネーム・命名レビュー |
| security-advisory | `security-maintenance` | dependency / framework の脆弱性情報の取り込み |
| estimation | `agent-delivery-estimation` | 中長期の release / roadmap 見積もり |
| onboarding | `onboarding` | 会話履歴なしで始められる docs の整備 |
| prose-artifact | `writing-discipline` | README / ADR / Issue / PR / commit 等、残る文章を書く前 |
| interaction-style | `interaction-discipline` | user とのやりとり、質問の絞り方、blocker の見せ方 |
| policy-evaluation | `policy-evaluation` | Skill / policy 自体を変更・評価する時 |
| skill-selection | `skill-selection` | Skill の追加・更新・採否を決める時 |
| ideation | `idea-discovery` | 既存の延長ではない発想を求められた時だけ |

## House rules

- source code（identifier・comment・developer 向け log を含む）と commit message は英語。internal documentation・Issue・PR・review discussion は日本語。localization resource は例外。
- commit message の形式: `<work-prefix>: <ごく短いtitle>`（既存例: `fix(runner): ...`）。
- text search は `rg` / `rg --files`。
- 新しい script を `.py` で追加しない。project の言語（TypeScript）か shell を使う。JavaScript は tool が TypeScript を受け付けない等の技術的な理由がある時だけ使う。
- 新しい container definition は `Containerfile`。
- project 固有の rule を global 設定・home directory・agent の私的 memory にだけ置かない。repository に残す。

## Judgment and recovery pointers

- user へ判断を返す条件・決定の優先順位: `engineering-decisions` Skill。
- 残る文章を書く前: `writing-discipline` Skill。
- 中断からの復旧: 会話履歴ではなく Issue / PR / branch / `docs/` から再開する。`agent-recovery` Skill。
