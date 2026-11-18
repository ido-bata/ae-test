# 要求充足・改善・最適性の契約

`Repo`は変更後の全体。`Obligation`は根拠付き成立条件。現状の実装詳細を根拠なく維持条件にしない。

```lean
universe u v
namespace SoftwareQuality
structure Obligation (Repo : Type u) (Source : Type v) where
  origin : Source
  holds : Repo → Prop
structure Task (Repo : Type u) (Source : Type v) where
  current : Repo
  obligations : List (Obligation Repo Source)
def Satisfies {Repo : Type u} {Source : Type v}
    (task : Task Repo Source) (candidate : Repo) : Prop :=
  ∀ obligation ∈ task.obligations, obligation.holds candidate
structure ValidResult {Repo : Type u} {Source : Type v}
    (task : Task Repo Source) where
  result : Repo
  correctness : Satisfies task result
def Optimal {Repo : Type u} {Source : Type v}
    (task : Task Repo Source) (better : Repo → Repo → Prop)
    (result : ValidResult task) : Prop :=
  ∀ alternative : Repo,
    Satisfies task alternative → ¬ better alternative result.result
end SoftwareQuality
```

これは抽象契約の記述であり、実プロジェクトの証明でも、Leanコンパイルを実施したという主張でもない。`origin`の存在は根拠の正当性を保証しない。

`better`は要求・制約・品質の優劣が確定してから定義する。既存構造や局所差分で`Repo`を狭めない。有限候補の最良、既知アンチケース不在、探索終了は`Optimal`ではない。部分順序や有限性をこの契約へ勝手に追加しない。

改善の証拠は `Satisfies task candidate` と `better candidate current` を別々に支える。最適性の証明は、比較対象全体についての不存在を要する。形式モデルと実ソースの意味論の対応、実行環境、前提の成立、成果物identityを確立した範囲でのみ保証を移す。

C1要求形式化、C2全体再構成、C3静的強制、C4適用範囲、C5非静的命題、C6実装対応、C7独立受理、C8不要構造抑制を別々に評価する。Skillや検査の存在は能力全体の成立ではない。最適性を証明していない成果物を「完全な最適」と報告しない。
