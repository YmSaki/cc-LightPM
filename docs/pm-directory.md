# `.pm/` の形式

状態はリポジトリ直下の `.pm/` にテキストで置きます。
git で追跡する想定です。

```text
.pm/
├── state.json         次のタスク番号
├── tasks/
│   └── T-0001.md      1タスク1ファイル（YAML frontmatter と本文）
└── log/
    └── 2026-10.jsonl  変更履歴（月ごと、追記のみ）
```

## タスクファイル

```markdown
---
schema: 1
id: T-0002
title: 保存処理
kind: feature
priority: max
status: in_progress
depends_on: [T-0001]
checklist:
  - "[x] 保存できる"
  - "[ ] 読み込める"
  - "[ ] 壊れたファイルでエラーを出す"
created: 2026-10-02T00:18:04.101Z
updated: 2026-10-02T01:02:11.512Z
---

タスクを JSON ファイルに保存して読み込む。
```

本文には、何をするタスクかの説明を書きます。

| フィールド | 内容 |
| --- | --- |
| `id` | `T-` と4桁以上の番号。採番はモッドが行う |
| `title` | 1行のタイトル |
| `kind` | `feature`、`bug`、`refactor`、`polish`、`chore`、`release` |
| `priority` | `max`、`xhigh`、`high`、`mid`、`low`、`xlow` |
| `status` | `todo`、`in_progress`、`done`、`dropped` |
| `depends_on` | 前提になるタスクの ID（任意）。循環は拒否する |
| `checklist` | やること。`[x]` が済み、`[ ]` が未済（1つ以上） |
| `severity`、`impacts` | バグの重大度と影響先（bug で必須） |
| `notes` | 今の状況のメモ（任意） |
| `created`、`updated` | 作成日時と更新日時 |

チェックリストの項目は、引用符で囲んだ `- "[x] 項目"` の形で書き出します。
手で書くときは、引用符のない `- [x] 項目` でも読めます。

タスクは削除しません。
不要になったら `dropped` にします。

`.pm/` は手で編集しても構いません。
ツールを呼ぶたびにディスクから読み直すので、手編集や `git pull` の後も読み込みの操作は要りません（帯と一覧をすぐ更新したいときは `/pm refresh`）。
読めないファイルは `/pm` に理由とともに表示され、一覧からは外れます。
モッドは `.pm/` の外へは書き込まず、書き込んだ後に読み戻して内容を確かめます。

## 変更履歴

タスクの変更は、すべて `.pm/log/YYYY-MM.jsonl` に追記されます。
各行には共通して `schema`、`ts`、`seq`（月内の連番）、`actor`、`event` が入ります。
`actor` は `main`（メインの会話）か `subagent:<id>`（サブエージェント）です。

| イベント | 記録するとき |
| --- | --- |
| `task.created` | 登録（種別、優先度、その優先度にした理由） |
| `task.reclassified` | 種別や優先度などの分類の変更（旧値、新値、理由） |
| `task.status` | 状態の変更（変更前と変更後） |
| `task.progress` | チェックリストの進捗の変化（済んだ数と全体の数） |
| `task.updated` | タイトル、説明、やること、前提、メモの変更（変えた項目） |

`/pm why <id>` は、このログからそのタスクの履歴を時系列で表示します。
