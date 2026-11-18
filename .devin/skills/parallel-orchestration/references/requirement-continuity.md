# Canonical requirement continuity at handoff and fan-in

This procedure is conditional for durable, complex, parallel or compaction-prone work. It refines Issue #152, not an alternative source of requirements.

## User-facing execution instruction authoring

ChatGPT等の上流assistantが作る「着手指示」「再開指示」「監督指示」「プロンプトにして」の指示文も、複数agentへのspawnと同じ**要求・権限・検証段階の継承境界**として扱う。対象が単一agentであっても適用する。promptは独立した仕様正本ではなく、目的、対象Issue/Spec/ADR（必要ならrevision）、担当scope、現在の実行段階と権限を示す短いrouting artifactとする。正本へ永続化すべき判断・受入条件を長文promptへ繰り返し記述しない。

指示の生成時に、**userが要求した内容**、**project-local正本に既存の内容**、**assistantによる推論・提案**を区別する。新しいtest/approval/verification条件を「安全のため」の名目で無断追加しない。変更を提案するなら正本の該当責務へ移し、必要なauthorityを得る。とくに [ADR-0036](../../../docs/adr/ADR-0036.md) に従うrelease-driven projectでは、ticket/PR単位の実機GUI・全OS CI・E2E・full build・deployやrelease trunk各pushのfull gateを実行指示が自動的に復活させてはいけない。高危険度の早期検証はproject-local quality profileに具体的failure modeと最小十分な検査がある場合に限る。規約移行前のCI/Issueに古い必須gateが残るなら、promptだけで迂回せず正本と設定の移行を実装タスクとして扱う。

生成前の照合点: (1) 目的・否定条件・scopeは維持されたか、(2) 受入条件・checkの**stage**と費用を勝手に変更していないか、(3) issue→releaseの自律landingとrelease→mainの権限を混同していないか、(4) NOT_RUN/DEFERREDをPASSと書いていないか、(5) 実行者が原文の正本を直接発見できるか。明示的なproject-specific exceptionと現行authorityを尊重する。途中の要約、孫agentへの再委譲、compaction後の再開でも同じ照合を繰り返す。

## Before spawn

複数agentへ委譲する前に、継続して守るべきscope・constraints・acceptance criteria・重要な決定をGitHub Issue / Spec / ADR等の適切な正本へ選別して反映する（`writing-discipline`）。派生Issueには元の要求の出典refと必要なrevisionを引き継ぎ、上流の重要な制約を追跡できるようにする。会話全体や長文promptをそのまま永続化しない。

## During spawn and unavailable sources

spawn inputには正本のrefと必要なrevision/snapshotを明示する。子は親の要約だけで仕様を確定せず、正本を直接読む。アクセス不可なら出典・版を識別できるimmutableな原文抜粋を渡し、送信側が委譲scope内の重要な要求・否定条件・受入基準をすべて含むことを照合する。網羅性を確認できない場合、子は推測で補わず、そのscopeの実装を停止して正本へのアクセスまたは正確な引き継ぎを要求する。短命taskで独立Issueを要しない場合も、親が確定した元のtask contractへの追跡性を維持する。

## Fan-in and recovery

fan-inではchildのsummary/完了宣言ではなく、正本の要求とcurrent artifact・validationを照合する。新たなscope/decisionをhandoff中に暗黙に確定させない。

A fresh agent must verify the original scope, negative constraints, acceptance criteria and resulting artifact; it must not treat a private summary/checkpoint or an inaccessible partial excerpt as authoritative. This rule does not force new Issues for small short-lived work.

## Recovery lifecycle

GitHub上のIssue/PR/branch metadataはdurable recovery evidenceであり、active durable ticket branchにpublished remote head + PRがない状態を正常状態として扱わない。PRが存在する場合もactive/incompleteならDraft、readiness条件を満たしていればReady for reviewであることをreconcileする。Ready ticket PRの未landing、land済みopen Issue、merged/landed後のstale ticket branchもdriftとしてrepairする。zero-diff release branchはDraft release PR invariantの例外だが、first meaningful integrated difference後はDraft release PRを必須とし、release PRをautonomous ticket landingへ含めない。
