# LightPM

LightPM は、Claude Code に課された作業を優先度とリリースフェーズで整理し、次にやる作業を示すプラグインです。

## インストール

Claude Code 2.1.287 以降が必要です。

```text
/plugin marketplace add YmSaki/cc-LightPM
/plugin install lightpm@cc-lightpm
```

手元のクローンを試すだけなら、`claude --plugin-dir /path/to/cc-lightpm` で起動します。

## できること

- 目的をタスクに分解し、優先度（`max` / `xhigh` / `high` / `mid` / `low` / `xlow`）を付けて登録する（`/lightpm:pm-plan`）
- 優先度の高い順にタスクを実装していく（`/lightpm:pm-run`）
- 作業中に気づいた別の作業を登録しておく（`/lightpm:pm-triage`）
- 今のフェーズ（Alpha → Beta → RC → GM）でやらない作業を後回しにし、フェーズが進んだら戻す
- 今やるタスクと残りを、プロンプトの上の帯とタスク一覧（`/pm view`）で見る
- タスクが選ばれた理由や後回しになった理由を、監査ログで追う（`/pm why`）
- 効果を計測する（`/pm metrics`） (未)

## ドキュメント

| 知りたいこと | 読むもの |
| --- | --- |
| スキルと `/pm` の使い方、タスク一覧の見方 | [docs/usage.md](docs/usage.md) |
| 優先度の決め方、フェーズと後回しの規則、タスクの選ばれる順 | [docs/rules.md](docs/rules.md) |
| `.pm/` のファイル形式、設定、監査ログ | [docs/pm-directory.md](docs/pm-directory.md) |
| テストの実行、ソースの構成 | [docs/development.md](docs/development.md) |

## ライセンス

GPL-3.0（[LICENSE](LICENSE)）
