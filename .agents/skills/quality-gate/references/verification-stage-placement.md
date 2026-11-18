# Stage-specific verification placement

- Layer: Practice. Decision: [ADR-0036](../../../docs/adr/ADR-0036.md)
- Applicable to the [release-driven-solo profile](../../../organization/profiles/release-driven-solo.md); each repository compiles its own project-local quality profile.
- Read when deciding ticket acceptance, CI/branch-protection triggers, native GUI verification, release freeze, or migration of existing gates.

## The principle

**Tests are not their execution schedule.** Keep cheap source-level evidence near code creation; require expensive end-to-end/native/package evidence at the release candidate where it protects the actual artifact. Never infer success from a skipped check. A release branch is not continuously release-ready.

Every required check states `property`, `stage`, `trigger`, `cost`, `candidate SHA / artifact / environment identity`, and `failure semantics`. A required check is blocking *at its stage*, not at every earlier stage.

## Change-risk mapping

| Change | Ticket landing (minimum sufficient early evidence) | Frozen candidate (broader evidence) |
| --- | --- | --- |
| Pure/domain logic | Focused unit/property checks | Affected integration as warranted |
| API/service | Unit + changed contract; bounded integration if interface risk | Applicable integration + critical E2E |
| DB schema/migration | Schema/contract, reversible test migration; early real-boundary test for unsafe shared state | Migration rehearsal, integration, smoke |
| Runtime/env/DI/network | Configuration/contract and only necessary cheap smoke | Production-like wiring/integration smoke |
| Frontend local component | Focused component + static checks | Critical journey E2E and visual checks when needed |
| Authentication/navigation | Component/contract and early high-risk security-path checks | Critical user journey and platform coverage |
| External API adapter | Unit, failure-path and contract | Real/sandbox adapter integration where relevant |
| Build/package/container | Targeted metadata/static compatibility and narrowly needed build | Clean production build/package + artifact smoke |
| Regular release-trunk push | Optional cheap integration health; no full gate/deploy | No candidate yet |
| Security defect | Regression/vulnerable-path checks; real integration if needed for safe trunk state | Broader applicable security/integration/E2E |

This is a default map to compile, not a universal mandate. Higher-risk changes may need earlier expensive checks. Record the concrete failure scenario, why deferral is unsafe, and the smallest adequate check. Do not equate any native file change with a mandatory full device matrix.

## Stage and evidence contract

1. **Worker**: focused checks and immediate diagnostics; do not run full CI, full package build or native GUI on every edit. Writing a test early does not require running the entire suite early. Property and behavior assertions should survive refactors.
2. **Ticket PR**: verify acceptance criteria for its own scope, current-head provenance, change-sensitive lint/type/static/unit/contract/integration, risk-specific regression, conflicts/staleness, and actionable review. A PR is not blocked merely because release-wide E2E, device, screenshots or human GUI acceptance remain NOT_RUN. Genuine unsafe shared-state operations require earlier protection.
3. **Release integration branch**: autonomously land eligible tickets and reconcile dependent branches. This branch may contain unfinished *combined* behavior. At its normal push event, allow cheap integration health, never automatically run full release suite or deploy. A failing required ticket check still blocks that ticket; do not relabel it as release-only after the fact without a justified contract revision.
4. **Frozen release candidate**: after a meaningful batch checkpoint, freeze scope and immutable SHA; run full applicable integration, critical E2E, clean packages, migration rehearsal, OS/browser/device matrices, native verification and security checks. A required missed check is a blocker, not green. Candidate changes invalidate affected evidence only; do not project an old SHA's green onto a different candidate.
5. **Human acceptance / publication**: owner reviews actual GUI/native experience on consolidated candidate when assigned; distinguish agent smoke, human inspection and publication availability. Issue Done can mean reached target release trunk, while release acceptance remains pending. This is not permission to claim the whole system production-verified.

Use explicit `PASS / FAIL / NOT_RUN / DEFERRED / BLOCKED / NOT_APPLICABLE`; a CI-skipped successful job does not imply its behavior was tested.

## CI and hooks

- **Ticket PR trigger**: only the stage-specific fast/bounded checks that protect release-trunk landing, including security checks whose risk applies early. Avoid identical full `push` + `pull_request` runs.
- **Release trunk push trigger**: optional cheap integration health; no full CI or deployment just because `release-*` advanced.
- **Candidate/freeze trigger**: explicit release-quality dispatch (or equivalent bounded candidate event) with SHA provenance and full applicable suite.
- **Main/tag**: post-release SHA/version consistency, publication and bounded deployment confirmation where required.
- **Required statuses**: align required checks to their stage. GitHub may leave path-filtered required workflows permanently Pending, while job-level skips may report Success. Design a reliably-present lightweight decision check if needed; a skipped platform job must not become evidence of platform verification. Inspect rulesets/branch protections before changing triggers.
- **pre-commit/pre-push hooks**: bounded local sanity checks only; do not silently turn every incremental push into complete integration, build, native session or remote deployment.
- **Retries/flakes**: identify independent failures, cancel superseded runs where safe, do not repeatedly rerun full suites to suppress defects.

## Review and agent autonomy

pstack's principles of small verifiable changes, architectural constraints, behavior-oriented tests, root-cause fixes, subtract-before-add and independent defect-seeking review are useful. They do **not** require a GUI session, multi-model swarm or multiple rounds for each Issue. Prefer a risk-sensitive one-pass or targeted review, escalating only for a real finding, novel contract or important unknown.

Normal ticket PR → release trunk is autonomous once its actual gate passes. Current default `release-* → main` requires explicit user release authorization; verification alone never creates release authority.

## Real-world migration and evaluation

Update canonical quality profiles, GitHub Actions, rulesets, hooks and Issue acceptance wording **together**. For every removed/moved mandatory check document the old failure mode, new stage, trigger, identity and evidence. Existing check names are not automatically valid after workflow changes. See [policy migration audit](../../../docs/audits/2026-11-16-verification-placement-audit.md).

Measure before and after: PR landing latency, CI runner-minutes, duplicate builds, GUI/device occupancy, freeze/test reruns, escaped defects, rollback and rework. Correct the policy if late defects and repairs outweigh saved feedback cost; there is no assumed universal optimum.
