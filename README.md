# LightPM

LightPM は、Claude Code に「次にやる作業」を**規則で1件だけ**選ばせるプラグイン（スキル＋サブエージェント＋モッド）です。

AI エージェントは、目の前の問題をその場で直し始めがちです。そのため、基本機能（`max`）が未完成でも軽微なバグ（`mid` 以下）に手を付け、重要な実装が後回しになります。LightPM は、リリースフェーズ（Alpha → Beta → RC → GM）と優先度（`max` / `xhigh` / `high` / `mid` / `low` / `xlow`）から着手順を決めます。範囲外で見つけた問題はその場で直させず、登録して後回しにします。

- **選択は決定的**: 同じ `.pm/` からは、常に同じタスクが選ばれます。LLM は分類（種別・優先度）にだけ使います。
- **人間の承認ゲートなし**: 分解 → 優先付け → 実装 → 検証を自走します。判断の理由は監査ログに残ります。
- **状態はすべてファイル**: `.pm/` 以下にテキストで置くので、git で追跡でき、セッションをまたいで再開できます。
- **実行時依存ゼロ**: TypeScript だけで書かれ、ビルド手順はありません。

## 必要なもの

- Claude Code 2.1.287 以降（モッドが使える版）

## インストール

マーケットプレイスとして追加する場合:

```text
/plugin marketplace add YmSaki/cc-LightPM
/plugin install lightpm@cc-lightpm
```

手元のクローンをそのセッションだけ読み込む場合:

```sh
claude --plugin-dir /path/to/cc-lightpm
```

## 使い方

```text
/lightpm:pm-plan TypeScript の CLI ToDo アプリ（追加・一覧・完了）を作る
```

目的を分解してタスクとして登録します。まず端から端まで通る基本シナリオを決め、それに必要なタスクを `max` にします。

```text
/lightpm:pm-run
```

ループを回します。`pm_next` が次のタスクを1件選び、サブエージェント `pm-implementer` が実装します。`pm_complete` が完了条件と変更範囲（`git diff`）を検証し、範囲外で見つかった問題は登録だけして次へ進みます。「待ち」「完了」「同じタスクの2回連続の失敗」のいずれかで止まります。`/lightpm:pm-run 3` のように、上限の件数も指定できます。

```text
/lightpm:pm-triage ログイン画面で長いメールアドレスが切れる
```

作業中に気づいた問題を、ルーブリックで分類して登録します（直しはしません）。

```text
/pm              状態（フェーズ、作業中、todo、後回し、抜ける条件）
/pm why T-0003   そのタスクが選ばれた・後回しになった理由（監査ログから）
```

プロンプトの上の帯に、現在のフェーズ、作業中のタスク、残数が1行で表示されます。

```text
LightPM Alpha · ▶ T-0003 CLI エントリと add を実装する [max] · todo 3 · 後回し 1 · 完了 2
```

### `/pm` のサブコマンド

| コマンド | 内容 |
| --- | --- |
| `/pm` / `/pm status` | フェーズ、作業中のタスク、todo・後回しの一覧、次の候補、フェーズを抜ける条件 |
| `/pm init [phase]` | `.pm/` を作る（`pm_add` でも自動で作られる） |
| `/pm next` | 次に選ばれるタスクを表示する（状態は変えない） |
| `/pm list [status]` | タスクの一覧 |
| `/pm why <id>` | 選択・後回し・再分類の履歴 |
| `/pm phase set <phase> [理由]` | フェーズの手動変更（`phase.set` として記録） |
| `/pm enforce <off\|inform\|warn\|block>` | ガードの強制レベル |
| `/pm policy` | 現在のフェーズポリシーの表 |
| `/pm refresh` | `.pm/` を読み直して帯を更新 |

## 規則

### 優先度

| 優先度 | 意味 |
| --- | --- |
| `max` | 基本機能。欠けると主目的が成立しない |
| `xhigh` | 主要シナリオの成立に必要。データ損失・重大なセキュリティ問題を含む |
| `high` | 重要。なくても使えるが、多くの利用者が困る |
| `mid` | 通常。影響が限定的、または回避策がある |
| `low` | 改善・見た目・軽微な不具合 |
| `xlow` | あれば良い。将来の候補 |

バグの優先度は、影響先の優先度 × 重大度（S0〜S3）の表から自動で決まります。`impacts` に既存タスクの ID を指定したときです。

### フェーズごとの着手できる下限（実効優先度）

| フェーズ | feature | bug | chore | refactor / polish | release |
| --- | --- | --- | --- | --- | --- |
| Alpha | `high` 以上 | `xhigh` 以上 | `mid` 以上 | `xhigh` 以上 | 不可 |
| Beta | `xhigh` 以上 | `mid` 以上 | `mid` 以上 | `high` 以上 | 不可 |
| RC | 不可 | `high` 以上、またはリリース阻害 | `high` 以上 | 不可 | 不可 |
| GM | 不可 | リリース阻害のみ | 不可 | 不可 | 可 |

下限に満たないタスクは `deferred`（後回し）になり、着手できる最初のフェーズ（`defer.until`）が記録されます。**実効優先度**は依存を考慮した優先度です。`max` のタスクの前提になっている `low` のタスクは `max` として扱われ、先に選ばれます。

着手できるタスクがなくなると、フェーズを抜ける条件を判定し、満たしていれば `pm_next` が自動で次のフェーズへ進みます。

- **Alpha → Beta**: `max` と `xhigh` の feature が未完了ゼロ
- **Beta → RC**: `xhigh` 以上の feature と `high` 以上の bug が未完了ゼロ
- **RC → GM**: リリース阻害の bug と `high` 以上の bug が未完了ゼロ
- **GM**: release タスクがすべて完了したらプロジェクト完了

ポリシーは `.pm/config.json` の `policy` で上書きできます（例: `{ "alpha": { "bug": "mid" } }`。`null` は不可）。

### 並べ替え

着手できるタスクは、次の順で並べて先頭を選びます。

1. 実効優先度（高い方が先）
2. 推移的に妨げているタスクの数（多い方が先）
3. フェーズの主役の種別（Alpha は feature、Beta と RC は bug、GM は release）
4. 見積（S → M → L → 未設定）
5. 作成日時（古い方が先）
6. ID

## コンポーネント

| 種類 | 名前 | 役割 |
| --- | --- | --- |
| スキル | `pm-plan` | 目的を分解し、分類して登録する |
| スキル | `pm-run` | `pm_next` から完了までのループを回す |
| スキル | `pm-triage` | 発見した問題を分類して登録する |
| サブエージェント | `lightpm:pm-implementer` | 1タスクを範囲内で実装し、JSON で報告する |
| ツール | `mcp__lightpm__pm_status` / `pm_next` / `pm_add` / `pm_update` / `pm_complete` | Claude が呼ぶ操作（モッドが登録） |
| コマンド | `/pm` | 人が使う |
| モッド | `hooks/lightpm.tsx` | ツールとコマンドの処理、プロンプトへの文脈の追加、帯、編集のガード、監査ログ |

モッドが使う API は `$.fs`（`.pm/` の読み書きのみ）、`$.process.run`（`git` のみ）、`$.state`、`$.ui`、`$.tool`、`$.command`、`$.clock`、`$.session.root` です。ネットワークも LLM も呼ばないので、プランや API キーを消費しません。`claude plugin validate .claude-plugin/plugin.json` で一覧を確認できます。

## ガード

`Edit` / `Write` / `NotebookEdit` の直前に、編集先が作業中のタスクの `scope.paths` に収まるかを確かめます。サブエージェントの編集にも効きます。

| レベル | 範囲外の編集 |
| --- | --- |
| `off` | 何もしない |
| `inform` | 通す。監査ログに記録し、帯に件数を出す |
| `warn`（既定） | 通す。トーストを出し、Claude にも注意を返し、監査ログに記録する |
| `block` | 拒否する。理由は「`pm_add` で登録して作業を続けて」という文面で Claude に返す |

`.pm/` 内の編集と、作業中のタスクがない状態での編集も違反として扱います。プロジェクトの外のファイルは対象外です。Bash での書き換え（`sed -i` など）は見えないため、`pm_complete` の差分検証が最後の砦になります。

範囲の検査は、うっかりした取り違えを防ぐための安全網です。意図的な回避は想定していません。

## `.pm/` の形式

```text
.pm/
├── config.json      { "schema": 1, "enforcement": "warn", "scopeVerify": true, "policy": {} }
├── state.json       { "schema": 1, "phase": "alpha", "nextId": 6, "active": null, "baseline": null }
├── tasks/
│   └── T-0001.md    1タスク1ファイル（YAML frontmatter + 本文）
└── log/
    └── 2026-10.jsonl  監査ログ（月ごと、追記のみ）
```

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
  - list/done の実装
estimate: S
created: 2026-10-02T00:18:04.101Z
updated: 2026-10-02T00:18:04.101Z
---

背景や再現手順などの自由記述。
```

`.pm/` は git で追跡する想定です。手で編集しても、次のツール呼び出しで読み直されます（`/pm refresh` で帯もすぐ更新できます）。読めないファイルは `/pm status` に理由とともに表示され、選択からは除外されます。タスクは削除せず、不要になったら `pm_update` で `dropped` にします。

### モッドなしで使う

managed settings などでモッドが無効な環境でも、スキルとサブエージェントは動きます。ただし `pm_*` ツールがないため、Claude が上の形式で `.pm/tasks/` を手で編集することになります。この場合、選択の決定性・ガード・帯は働きません。

## 開発

```sh
npm test            # コアの単体テスト（node --test）+ モッドのテスト（claude plugin test）
npm run test:core   # Node 22.18 以降。Claude Code なしで動く
npm run test:mod    # claude plugin test .
npm run validate    # claude plugin validate .（マーケットプレイスとプラグインの定義）
```

```text
src/core/   純粋関数（型、ポリシー、frontmatter、glob、選択、登録・更新・完了、ガード判定、文面）
src/io/     .pm/ の読み書き（.pm/ の外へは書かない、書き込み後に読み戻して検証）
hooks/      モッドの入口
skills/ agents/   スキルとサブエージェント
tests/core/*.spec.ts   コアの単体テスト（表駆動、並べ替えの性質テスト、性能）
tests/mod/*.test.ts    モッドのテスト（$.fs と git をメモリ上で置き換え）
```

型チェック（`npm run typecheck`）には、Claude Code がモッドを読み込んだときに書き出す `.claude-plugin/types/` が必要です。先に一度 `claude --plugin-dir .` で起動してください。

仕様書 v0.1 の受け入れ基準のうち、AC-1〜AC-10 はテストで確かめています。

## 仕様書 v0.1 の未検証事項の結果と、実装上の判断

| ID | 結果 |
| --- | --- |
| OQ-1 | `tool.call` はサブエージェントの `Edit` / `Write` にも発火し、`agentId` が付く（実機で確認。監査ログの `actor` は `subagent:<id>`） |
| OQ-2 | フックのモジュールは他のファイルを `import` できる（`.ts` 拡張子付き）。バンドルは不要 |
| OQ-3 | `$.fs.write` は親ディレクトリを作る。`mkdir` は不要 |
| OQ-4 | サブエージェントは `agents/pm-implementer.md` で提供（`lightpm:pm-implementer`） |
| OQ-5〜7 | 仕様書の提案どおりを既定値にした。`config.json` の `policy` で変えられる |

仕様書から変えた点・補った点:

- **読み込みは毎回ディスクから**: `$.state` には帯とガード用の要約だけを置きます。ツールのたびに `.pm/` を読み直すので、手編集や `git pull` の後も `/pm refresh` は基本的に不要です。
- **後回しの見直しは毎回**: 昇格時だけでなく `pm_next` のたびに見直します。後回しのタスクが、後から `max` のタスクの前提になった場合に、着手できずに止まるのを防ぐためです。
- **`dropped` の依存は解決済みとして扱います。**
- **バグの優先度は表が優先**: `impacts` が既存タスクなら、指定された `priority` より表の値を使います。
- **完了時の差分検証の基準点**: タスクを選んだ時点で `git stash create` を取り、そこからの変更だけを検証します。前のタスクの未コミットの変更を数えないためです。
- **`pm_complete` は `discovered` を自動登録しません**: 分類に LLM の判断が要るためで、代わりに `pm_add` での登録を促す文を返します。
- **`/pm add` はありません**: 登録は `/lightpm:pm-triage` か `pm_add` で行います。
- **ID の並行採番**: モッド内で書き込みを直列化しているので、並行した `pm_add` でも ID は重複しません。

### まだないもの

- CI でのモッドの検証（`claude plugin validate --strict` と `claude plugin test` を、最小対応版・最新版の両方で）。今の CI はコアの単体テストだけを回す
- モッドなしでも決定的に選択するための Node の入口
- 効果の計測（優先度の逆転数、範囲外編集率、`max` の完了までの時間）
- 複数人・複数リポジトリでの同期（v1 の対象外）

## ライセンス

GPL-3.0（[LICENSE](LICENSE)）
