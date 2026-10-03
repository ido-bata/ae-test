# ae-test

After Effects プラグイン／スクリプト向けの Playwright-like automated testing framework。

## Scope

ae-test は ae-a8n を実行基盤として利用し、テスト定義、fixture、assertion、snapshot、timeout、report、artifact collection などのテスト体験を提供する。

After Effects 自体の操作 primitive は ae-a8n に置き、remote execution infrastructure は ae-farm に置く。

## Ecosystem

- **ae-a8n** — After Effects automation runtime / API
- **ae-test** — local / CI test runner
- **ae-farm** — remote Mac / Windows execution service

`ae-devtools` は別軸の開発支援プロジェクトであり、この自動化系列との共通依存を前提にしない。

## Status

初期設計段階。最初の統合ゴールは、ae-a8n を通して実在する After Effects プラグインを適用し、PNG を生成して assertion まで無人で完了すること。
