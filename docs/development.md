# 開発

## テストと検証

```sh
npm test            # コアの単体テストとモッドのテストをまとめて実行
npm run test:core   # コアの単体テスト（node --test。Node 22.18 以降、Claude Code なしで動く）
npm run test:mod    # モッドのテスト（claude plugin test）
npm run validate    # マーケットプレイスとプラグインの定義の検証（claude plugin validate）
npm run typecheck   # 型チェック（tsc）
```

型チェックには、Claude Code がモッドを読み込んだときに書き出す `.claude-plugin/types/` が必要です。
先に一度 `claude --plugin-dir .` で起動してください。

CI では、プルリクエストごとにコアの単体テストを回します。
モッドの検証（`claude plugin validate --strict` と `claude plugin test`）も、Claude Code の最小対応版と最新版の両方で回します (未)。

## ソースの構成

```text
src/core/              純粋関数（型、優先度と並び順、frontmatter、登録と更新、文面）
src/io/                .pm/ の読み書き
hooks/                 モッドの入口
skills/                スキル
types/                 モッドが $.state に置く値の型
tests/core/*.spec.ts   コアの単体テスト
tests/mod/*.test.ts    モッドのテスト（$.fs をメモリ上で置き換える）
```

## プラグインの構成

| 種類 | 名前 | 役割 |
| --- | --- | --- |
| スキル | `pm-plan` | 目的を分解し、分類して登録する |
| スキル | `pm-triage` | 気づいた作業を分類して登録する |
| モッド | `hooks/lightpm.tsx` | ツールとコマンドの処理、プロンプトへの要約の追加、帯、タスク一覧のペイン、変更履歴 |

モッドが使う API は `$.fs`（`.pm/` の読み書きのみ）、`$.state`、`$.ui`、`$.tool`、`$.command`、`$.clock`、`$.session.root` です。
ネットワークも LLM も呼ばないので、モッドがプランや API キーを消費することはありません。
`claude plugin validate .claude-plugin/plugin.json` で、モッドが使う API の一覧を確認できます。
