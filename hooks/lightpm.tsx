// LightPM のモッド。ツールとコマンドを登録し、.pm/ を読み書きし、帯とタスク一覧のペインを出す。
// 判断はすべて src/core の純粋関数が行い、ここは入出力だけを受け持つ。

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { bandText, boardRows, contextFor, formatList, formatSaved, formatShow, formatWhy, summarize } from '../src/core/format.ts'
import type { ListFilter, Summary } from '../src/core/format.ts'
import { InputError, addTask, updateTask } from '../src/core/ops.ts'
import { STATUSES } from '../src/core/types.ts'
import { Repo } from '../src/io/repo.ts'
import type { Loaded } from '../src/io/repo.ts'
import type { LightpmBoardRow, LightpmSummary } from '../types'

type $ = EngineInterface

const SUMMARY = { plugin: 'lightpm', key: 'summary' } as const
const summaryAtom = atom(SUMMARY, null)
const boardAtom = atom({ plugin: 'lightpm', key: 'board' } as const, [])
const expandedAtom = atom({ plugin: 'lightpm', key: 'expanded' } as const, [])
const showDoneAtom = atom({ plugin: 'lightpm', key: 'showDone' } as const, false)

/** タスク一覧のペイン。 */
const PANE = 'lightpm-tasks'
const openBoard = ($: $) => $.ui.open({ id: PANE, title: 'LightPM タスク', focus: true, closeOnEscape: true })

const NOT_INITIALIZED =
  'LightPM はこのプロジェクトでまだ使われていません（.pm/ がない）。/pm init で始めるか、pm_add でタスクを登録すると .pm/ が作られます。'

// ---- ツールの定義 ----

const PRIORITY = { type: 'string', enum: ['max', 'xhigh', 'high', 'mid', 'low', 'xlow'] }
const STRINGS = { type: 'array', items: { type: 'string' } }
const NUMBERS = { type: 'array', items: { type: 'integer' } }

const TASK_FIELDS = {
  title: { type: 'string', description: '1行のタイトル' },
  kind: { type: 'string', enum: ['feature', 'bug', 'refactor', 'polish', 'chore', 'release'] },
  priority: { ...PRIORITY, description: 'ルーブリックで判定した優先度。bug で impacts が既存タスクなら、表から自動で決まる' },
  severity: {
    type: 'string',
    enum: ['S0', 'S1', 'S2', 'S3'],
    description: 'bug で必須。S0=データ損失/クラッシュ/セキュリティ, S1=機能が使えない, S2=回避策のある劣化, S3=外観・軽微',
  },
  impacts: { type: 'string', description: 'bug で必須。影響を受けるタスク ID（T-0003）か機能名' },
  impact_priority: { ...PRIORITY, description: 'impacts が機能名のとき、その機能の優先度（バグの表に使う）' },
  body: { type: 'string', description: '何をするタスクかの説明' },
  checklist: { ...STRINGS, description: 'やること。項目ごとに済みにして進捗を表す' },
  depends_on: { ...STRINGS, description: '前提になるタスク ID。一覧に表示するだけで、並び順には影響しない' },
}

const TOOLS = [
  {
    name: 'pm_list',
    description: 'LightPM: どんなタスクがあるかを、状態ごとに優先度の高い順で返す。既定は未完了（作業中と未着手）だけ。',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['open', 'all', ...STATUSES], description: '既定は open（作業中と未着手）' } },
    },
  },
  {
    name: 'pm_show',
    description: 'LightPM: タスクの内容（説明、やることのチェックリストと進捗、前提、メモ）を返す。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'タスク ID（T-0001）' } }, required: ['id'] },
  },
  {
    name: 'pm_add',
    description: 'LightPM: タスクを1件登録する。作業中に気づいた別の作業もこれで登録する。.pm/ がなければ作る。',
    inputSchema: {
      type: 'object',
      properties: { ...TASK_FIELDS, reason: { type: 'string', description: 'その優先度にした理由（1文）。変更履歴に残る' } },
      required: ['title', 'kind', 'checklist'],
    },
  },
  {
    name: 'pm_update',
    description:
      'LightPM: タスクの進捗や内容を更新する。check / uncheck でやることの項目（1 から数える番号）を済みにしたり戻したりする。status を指定しなければ、項目を済みにすると作業中に、全部済むと完了になる。種別や優先度を変えるときは reason が必須。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'タスク ID（T-0001）' },
        check: { ...NUMBERS, description: '済みにする項目の番号（1 から）' },
        uncheck: { ...NUMBERS, description: '済みを戻す項目の番号（1 から）' },
        status: { type: 'string', enum: [...STATUSES], description: 'todo / in_progress / done / dropped（取り下げ）' },
        ...TASK_FIELDS,
        checklist: { ...STRINGS, description: 'やることを置き換える。同じ文面の項目は済みの印を引き継ぐ' },
        notes: { type: 'string', description: '今の状況のメモ' },
        reason: { type: 'string', description: '変更の理由。種別や優先度を変えるときは必須' },
      },
      required: ['id'],
    },
  },
]

// ---- 共通 ----

/** 書き込みを1本の列に並べる。並行したツール呼び出しで id が重複しないように。 */
let chain: Promise<unknown> = Promise.resolve()
const exclusive = <T,>(work: () => Promise<T>): Promise<T> => {
  const run = chain.then(work, work)
  chain = run.catch(() => undefined)
  return run
}

const nowIso = async ($: $): Promise<string> => new Date(await $.clock.now()).toISOString()

const repoOf = async ($: $): Promise<Repo> =>
  new Repo(
    {
      read: path => $.fs.read(path) as Promise<string>,
      write: (path, text) => $.fs.write(path, text),
      list: path => $.fs.list(path),
      exists: path => $.fs.exists(path),
    },
    await $.session.root(),
  )

const actorOf = (e: { agentId?: string }): string => (e.agentId ? `subagent:${e.agentId}` : 'main')

const refresh = async ($: $, repo: Repo, loaded?: Loaded): Promise<Summary | null> => {
  if (!loaded && !(await repo.exists())) {
    await update($, summaryAtom, () => null)
    await update($, boardAtom, () => [])
    return null
  }
  const snapshot = loaded ?? (await repo.load())
  const summary = summarize(snapshot.tasks, snapshot.errors.length)
  await update($, summaryAtom, () => summary as LightpmSummary)
  await update($, boardAtom, () => boardRows(snapshot.tasks) as LightpmBoardRow[])
  return summary
}

/** 状態を変える操作：読み込み → コア → 書き込み → 帯と一覧の更新、を排他で行う。 */
const mutate = <T,>($: $, work: (repo: Repo, loaded: Loaded, now: string) => Promise<T>): Promise<T> =>
  exclusive(async () => {
    const repo = await repoOf($)
    const loaded = await repo.load()
    const now = await nowIso($)
    const result = await work(repo, loaded, now)
    await refresh($, repo)
    return result
  })

/** 読むだけの操作。.pm/ がなければ案内を返す。 */
const inspect = async ($: $, work: (loaded: Loaded, repo: Repo) => Promise<string> | string): Promise<string> => {
  const repo = await repoOf($)
  if (!(await repo.exists())) return NOT_INITIALIZED
  return work(await repo.load(), repo)
}

const answer = async (work: () => Promise<string>): Promise<{ result: string } | { deny: string }> => {
  try {
    return { result: await work() }
  } catch (e) {
    if (e instanceof InputError) return { deny: `LightPM: ${e.message}` }
    return { deny: `LightPM の内部エラー: ${e instanceof Error ? e.message : String(e)}` }
  }
}

const FILTERS: readonly string[] = ['open', 'all', ...STATUSES]
const toFilter = (value: unknown): ListFilter => (typeof value === 'string' && FILTERS.includes(value) ? (value as ListFilter) : 'open')

const showTask = (loaded: Loaded, id: string | undefined): string => {
  const task = loaded.tasks.find(t => t.id === id)
  return task ? formatShow(task, loaded.tasks) : `タスク ${id || '(id なし)'} は見つかりません。`
}

// ---- /pm ----

const HELP = [
  '/pm                     未完了のタスク（作業中と未着手）を優先度順に表示',
  '/pm view                タスク一覧のペインを開く（選ぶとやることを展開する）',
  '/pm show <id>           タスクの内容とやること',
  '/pm list [status|all]   状態を指定した一覧（todo / in_progress / done / dropped）',
  '/pm why <id>            タスクの変更履歴（優先度や状態をいつ、なぜ変えたか）',
  '/pm init                .pm/ を作る',
  '/pm refresh             .pm/ を読み直して帯と一覧を更新',
].join('\n')

const runCommand = async ($: $, args: string): Promise<string> => {
  const [sub = 'list', ...rest] = args.trim().split(/\s+/).filter(s => s !== '')
  const repo = await repoOf($)
  if (sub === 'help') return HELP
  if (sub === 'init') {
    const created = await exclusive(() => repo.init())
    await refresh($, repo)
    return created ? '.pm/ を作りました。/lightpm:pm-plan で目的をタスクに分解して登録できます。' : '.pm/ は既にあります。'
  }
  if (!(await repo.exists())) return NOT_INITIALIZED
  switch (sub) {
    case 'list':
    case 'status': {
      const loaded = await repo.load()
      await refresh($, repo, loaded)
      return formatList(loaded.tasks, toFilter(rest[0]), loaded.errors)
    }
    case 'view': {
      await refresh($, repo)
      const opened = await openBoard($)
      return opened.isPlaced ? 'タスク一覧を開きました（Esc で閉じる）。' : `タスク一覧を開けませんでした: ${opened.reason}`
    }
    case 'show':
      return showTask(await repo.load(), rest[0])
    case 'why': {
      const id = rest[0]
      if (!id) return '使い方: /pm why T-0012'
      const loaded = await repo.load()
      return formatWhy(id, loaded.tasks.find(t => t.id === id), await repo.readLog())
    }
    case 'refresh': {
      const loaded = await repo.load()
      await refresh($, repo, loaded)
      return `読み直しました（タスク ${loaded.tasks.length} 件${loaded.errors.length > 0 ? `、読込エラー ${loaded.errors.length} 件` : ''}）。`
    }
    default:
      return `知らないサブコマンドです: ${sub}\n${HELP}`
  }
}

// ---- 登録 ----

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const tool of TOOLS) await $.tool.register(tool)
    await $.command.register({ name: 'pm', description: 'LightPM: タスクの一覧と内容（/pm help）', argumentHint: '[view|show|list|why|init|refresh]' })
    try {
      await refresh($, await repoOf($))
    } catch (err) {
      $.ui.log(`LightPM: .pm/ を読み込めませんでした: ${String(err)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: 'pm' }, async ($, e) => {
    try {
      return { text: await runCommand($, e.args) }
    } catch (err) {
      return { text: `LightPM の内部エラー: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  // ---- ツール ----

  on('tool.call', { tool: 'mcp__lightpm__pm_list' }, async ($, e) =>
    answer(() => inspect($, loaded => formatList(loaded.tasks, toFilter(e.status), loaded.errors))),
  )

  on('tool.call', { tool: 'mcp__lightpm__pm_show' }, async ($, e) =>
    answer(() => inspect($, loaded => showTask(loaded, typeof e.id === 'string' ? e.id.trim() : undefined))),
  )

  on('tool.call', { tool: 'mcp__lightpm__pm_add' }, async ($, e) =>
    answer(() =>
      mutate($, async (r, loaded, now) => {
        let snapshot: Loaded = loaded
        if (!(await r.exists())) {
          await r.init()
          snapshot = await r.load()
        }
        const outcome = addTask(snapshot, e, now, actorOf(e))
        await r.persist(outcome, now)
        return formatSaved('登録', outcome.result.task, outcome.result.notes)
      }),
    ),
  )

  on('tool.call', { tool: 'mcp__lightpm__pm_update' }, async ($, e) =>
    answer(async () => {
      const repo = await repoOf($)
      if (!(await repo.exists())) return NOT_INITIALIZED
      return mutate($, async (r, loaded, now) => {
        const outcome = updateTask(loaded, e, now, actorOf(e))
        await r.persist(outcome, now)
        return formatSaved('更新', outcome.result.task, outcome.result.notes)
      })
    }),
  )

  // ---- 文脈・帯 ----

  on('prompt.submit', async ($, e, next) => {
    const summary = (await $.state.get(SUMMARY)).value
    if (!summary) return next(e)
    return next({ ...e, context: [...(e.context ?? []), contextFor(summary)] })
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await refresh($, await repoOf($))
      } catch (err) {
        $.ui.log(`LightPM: .pm/ を読み込めませんでした: ${String(err)}`, { to: 'debug' })
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const summary = await read($, summaryAtom)
    if (!summary) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box gap={1}>
        <Text dimColor wrap="truncate-end">
          {bandText(summary)}
        </Text>
        <Button key="board" label="一覧" onPress={() => void openBoard($)} />
      </Box>
    )
  })

  // ---- タスク一覧のペイン：優先度順に並べ、選ぶと説明とやることを展開する ----

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const summary = await read($, summaryAtom)
    if (!summary) {
      return (
        <Box>
          <Text dimColor>このプロジェクトでは LightPM を使っていません（/pm init で始める）。</Text>
        </Box>
      )
    }
    const rows = await read($, boardAtom)
    const expanded = await read($, expandedAtom)
    const showDone = await read($, showDoneAtom)
    const toggle = (id: string) => () =>
      void update($, expandedAtom, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))

    const row = (r: LightpmBoardRow) => {
      const isOpen = expanded.includes(r.id)
      const progress = r.progress.total > 0 ? `  ${r.progress.done}/${r.progress.total}` : ''
      const deps = r.dependsOn.length > 0 ? `  前提: ${r.dependsOn.map(d => `${d.id}（${d.status}）`).join(', ')}` : ''
      return (
        <Box key={`row:${r.id}`} flexDirection="column">
          <Button key={`t:${r.id}`} plain label={`${isOpen ? '▾' : '▸'} ${r.id} [${r.priority}] ${r.title}${progress}`} onPress={toggle(r.id)} />
          {isOpen && (
            <Box key={`d:${r.id}`} flexDirection="column" paddingLeft={4}>
              {r.body !== '' && <Text wrap="wrap">{r.body}</Text>}
              <Text dimColor>やること</Text>
              {r.checklist.map((item, i) => (
                <Text wrap="wrap" dimColor={item.done}>{`[${item.done ? 'x' : ' '}] ${i + 1}. ${item.text}`}</Text>
              ))}
              <Text dimColor wrap="wrap">{`種別 ${r.kind}${r.severity ? ` · 重大度 ${r.severity}` : ''}${r.impacts ? ` · 影響 ${r.impacts}` : ''}${deps}`}</Text>
            </Box>
          )}
        </Box>
      )
    }

    const section = (key: string, heading: string, list: LightpmBoardRow[]) =>
      list.length === 0 ? null : (
        <Box key={`g:${key}`} flexDirection="column" marginTop={1}>
          <Text dimColor>{`${heading}（${list.length}）`}</Text>
          {list.map(row)}
        </Box>
      )

    const done = rows.filter(r => r.group === 'done')
    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">{`LightPM · 作業中 ${summary.counts.in_progress} · 未着手 ${summary.counts.todo} · 完了 ${summary.counts.done}`}</Text>
        {summary.counts.in_progress + summary.counts.todo === 0 && <Text dimColor>未完了のタスクはありません。/lightpm:pm-plan で登録できます。</Text>}
        {section('active', '作業中', rows.filter(r => r.group === 'active'))}
        {section('todo', '未着手', rows.filter(r => r.group === 'todo'))}
        {done.length > 0 && (
          <Box key="done" flexDirection="column" marginTop={1}>
            <Button key="toggle-done" plain label={`${showDone ? '▾' : '▸'} 完了（${done.length}）`} onPress={() => void update($, showDoneAtom, v => !v)} />
            {showDone && done.map(row)}
          </Box>
        )}
      </Box>
    )
  })
}
