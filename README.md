# LightPM

LightPM は、Claude Code で進めるプロジェクトのタスクを優先度で管理し、ユーザーに見えるようにするプラグインです。

## インストール

Claude Code 2.1.287 以降が必要です。

```text
/plugin marketplace add YmSaki/cc-LightPM
/plugin install lightpm@cc-lightpm
```

手元のクローンを試すだけなら、`claude --plugin-dir /path/to/cc-lightpm` で起動します。

## できること

- 目的をタスクに分解し、優先度（`max` / `xhigh` / `high` / `mid` / `low` / `xlow`）を付けて登録する（`/lightpm:pm-plan`）
- どんなタスクがあるかを優先度順に見る（`/pm`、プロンプトの上の帯、タスク一覧の `/pm view`）
- 何をするタスクかを見る（説明と、やることのチェックリスト）
- やることを済みにして進捗を更新する（全部済むと完了）
- 作業中に気づいた別の作業を登録する（`/lightpm:pm-triage`）
- バグの優先度を、重大度と影響先から決める
- 優先度や状態をいつ、なぜ変えたかを追う（`/pm why`）

## ドキュメント

| 知りたいこと | 読むもの |
| --- | --- |
| スキルと `/pm` の使い方、タスク一覧、Claude や実装用のハーネスとの受け渡し | [docs/usage.md](docs/usage.md) |
| 優先度の決め方、バグの優先度の表、一覧の並び順 | [docs/rules.md](docs/rules.md) |
| `.pm/` のファイル形式、変更履歴 | [docs/pm-directory.md](docs/pm-directory.md) |
| テストの実行、ソースの構成 | [docs/development.md](docs/development.md) |

## ライセンス

GPL-3.0（[LICENSE](LICENSE)）
