# `.pm/` の形式

状態はリポジトリ直下の `.pm/` にテキストで置きます。
git で追跡する想定です。

```text
.pm/
├── config.json        設定（フェーズポリシーの上書き）
├── state.json         現在のフェーズ、次のタスク番号、作業中のタスク
├── tasks/
│   └── T-0001.md      1タスク1ファイル（YAML frontmatter と本文）
└── log/
    └── 2026-10.jsonl  監査ログ（月ごと、追記のみ）
```

## タスクファイル

```markdown
---
schema: 1
id: T-0003
title: CLI エントリと add コマンドを実装する
kind: feature
priority: max
status: todo
depends_on: [T-0002]
scope:
  paths: ["src/cli.ts", "src/commands/add.ts", "tests/add.test.ts"]
acceptance:
  - todo add <title> でタスクが保存され、追加した id を表示する
non_goals:
  - list と done の実装
estimate: S
created: 2026-10-02T00:18:04.101Z
updated: 2026-10-02T00:18:04.101Z
---

背景や再現手順などの自由記述。
```

| フィールド | 内容 |
| --- | --- |
| `id` | `T-` と4桁以上の番号。採番はモッドが行う |
| `title` | 1行のタイトル |
| `kind` | `feature`、`bug`、`refactor`、`polish`、`chore`、`release` |
| `priority` | `max`、`xhigh`、`high`、`mid`、`low`、`xlow` |
| `status` | `todo`、`in_progress`、`done`、`deferred`、`dropped` |
| `depends_on` | 実装上の前提になるタスクの ID。循環は拒否する |
| `scope.paths` | 主に触るファイルやディレクトリの目安（任意） |
| `acceptance` | 完了条件（1つ以上） |
| `non_goals` | このタスクに含めないもの（任意） |
| `estimate` | `S`、`M`、`L`（任意。並べ替えに使う） |
| `severity`、`impacts` | バグの重大度と影響先（bug で必須） |
| `release_blocker` | リリース阻害のバグか |
| `defer.until`、`defer.reason` | 後回しの解除先と理由 |
| `failures`、`notes` | 連続した失敗の回数と、直近のメモ |
| `created`、`updated` | 作成日時と更新日時 |

タスクは削除しません。
不要になったら `pm_update` で `dropped` にします。

`.pm/` は手で編集しても構いません。
ツールを呼ぶたびにディスクから読み直すので、手編集や `git pull` の後も読み込みの操作は要りません（帯と一覧をすぐ更新したいときは `/pm refresh`）。
読めないファイルは `/pm status` に理由とともに表示され、選択からは外れます。
モッドは `.pm/` の外へは書き込まず、書き込んだ後に読み戻して内容を確かめます。

## 設定

`.pm/config.json` の `policy` で、[フェーズごとの着手できる下限](rules.md#フェーズごとの着手できる下限)を上書きできます。
変えたい項目だけを書きます。

```json
{ "schema": 1, "policy": { "alpha": { "bug": "mid", "polish": null } } }
```

値は優先度の名前で、`null` はその種別を不可にします。
`/pm policy` で、上書きを反映した表を確認できます。

## 監査ログ

状態の変化と選択は、すべて `.pm/log/YYYY-MM.jsonl` に追記されます。
各行には共通して `schema`、`ts`、`seq`（月内の連番）、`actor`、`event` が入ります。
`actor` は `core`、`main`、`subagent:<id>`、`user` のいずれかです。

| イベント | 記録するとき |
| --- | --- |
| `task.created` | 登録（分類の理由を含む） |
| `task.selected` | `pm_next` による選択（候補数、着手可能数、上位3件の並べ替えキー） |
| `task.deferred`、`task.restored` | 後回しにしたとき、todo に戻したとき |
| `task.reclassified` | 分類の変更（旧値、新値、理由） |
| `task.status`、`task.updated` | 状態の変更、そのほかの項目の変更 |
| `task.completed`、`task.incomplete`、`task.failed` | 完了、完了条件の不足、失敗 |
| `phase.advanced`、`phase.set` | 自動の昇格、手動の変更 |
| `agent.spawn` | サブエージェントの起動 |
