// LightPM のモッド。ツールとコマンドを登録し、.pm/ を読み書きし、帯とタスク一覧のペインを出す。
// 判断はすべて src/core の純粋関数が行い、ここは入出力だけを受け持つ。

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { PHASE_LABEL, bandText, boardRows, contextFor, formatComplete, formatList, formatNext, formatPolicy, formatStatus, formatWhy, summarize } from '../src/core/format.ts'
import type { Summary } from '../src/core/format.ts'
import { InputError, addTask, completeTask, setPhase, updateTask } from '../src/core/ops.ts'
import { nextTask } from '../src/core/select.ts'
import { PHASES } from '../src/core/types.ts'
import type { Phase } from '../src/core/types.ts'
import { Repo } from '../src/io/repo.ts'
import type { Loaded } from '../src/io/repo.ts'
import type { LightpmBoardRow, LightpmSummary } from '../types'

type $ = EngineInterface

const SUMMARY = { plugin: 'lightpm', key: 'summary' } as const
const summaryAtom = atom(SUMMARY, null)
const boardAtom = atom({ plugin: 'lightpm', key: 'board' } as const, [])
const expandedAtom = atom({ plugin: 'lightpm', key: 'expanded' } as const, [])

/** タスク一覧のペイン。 */
const PANE = 'lightpm-tasks'
const openBoard = ($: $) => $.ui.open({ id: PANE, title: 'LightPM タスク', focus: true, closeOnEscape: true })

const NOT_INITIALIZED =
  'LightPM はこのプロジェクトでまだ使われていません（.pm/ がない）。/pm init で始めるか、pm_add でタスクを登録すると .pm/ が作られます。'

// ---- ツールの定義 ----

const PRIORITY = { type: 'string', enum: ['max', 'xhigh', 'high', 'mid', 'low', 'xlow'] }
const KIND = { type: 'string', enum: ['feature', 'bug', 'refactor', 'polish', 'chore', 'release'] }
const SEVERITY = { type: 'string', enum: ['S0', 'S1', 'S2', 'S3'] }
const STRINGS = { type: 'array', items: { type: 'string' } }

const TASK_FIELDS = {
  title: { type: 'string', description: '1行のタイトル' },
  kind: KIND,
  priority: { ...PRIORITY, description: 'ルーブリックで判定した優先度。bug で impacts が既存タスクなら、表から自動で決まる' },
  severity: { ...SEVERITY, description: 'bug で必須。S0=データ損失/クラッシュ/セキュリティ, S1=機能が使えない, S2=回避策のある劣化, S3=外観・軽微' },
  impacts: { type: 'string', description: 'bug で必須。影響を受けるタスク ID（T-0003）か機能名' },
  impact_priority: { ...PRIORITY, description: 'impacts が機能名のとき、その機能の優先度（バグの表に使う）' },
  depends_on: { ...STRINGS, description: '実装上の前提になるタスク ID。「優先度が高いから先に」は依存ではない' },
  scope_paths: { ...STRINGS, description: '主に触るファイルやディレクトリの目安（ルートからの相対、glob 可）。実装者への手がかり' },
  acceptance: { ...STRINGS, description: '完了条件。1つ以上' },
  non_goals: { ...STRINGS, description: '紛らわしいときだけ、このタスクに含めないもの' },
  estimate: { type: 'string', enum: ['S', 'M', 'L'] },
  release_blocker: { type: 'boolean', description: 'リリースを阻害するバグか' },
  body: { type: 'string', description: '背景や再現手順（自由記述）' },
  reason: { type: 'string', description: '分類の理由（1文）。監査ログに残る' },
}

const TOOLS = [
  {
    name: 'pm_status',
    description: 'LightPM: 現在のフェーズ、作業中のタスク、todo と後回しの一覧、フェーズを抜ける条件を返す。状態は変えない。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pm_next',
    description:
      'LightPM: 次に着手するタスクを規則で1件決めて返す（作業中のものがあればそれ）。選んだタスクは in_progress になる。結果のタスク契約をそのまま pm-implementer に渡す。「待ち」か「完了」ならループを終える。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pm_add',
    description:
      'LightPM: タスクを1件登録する。作業中に気づいた別の作業もこれで登録すれば、優先度順に回ってくる。今のフェーズで着手しないものは自動で後回し（deferred）になる。.pm/ がなければ作る。',
    inputSchema: { type: 'object', properties: TASK_FIELDS, required: ['title', 'kind', 'acceptance'] },
  },
  {
    name: 'pm_update',
    description:
      'LightPM: タスクを更新・再分類する（理由は必須、監査ログに旧値と新値が残る）。status は todo（差し戻し）か dropped（取り下げ）だけ。完了は pm_complete で行う。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'タスク ID（T-0001）' },
        ...TASK_FIELDS,
        reason: { type: 'string', description: '変更の理由（必須）' },
        status: { type: 'string', enum: ['todo', 'dropped'] },
        notes: { type: 'string', description: '失敗の記録などのメモ' },
      },
      required: ['id', 'reason'],
    },
  },
  {
    name: 'pm_complete',
    description:
      'LightPM: pm-implementer の報告を渡してタスクを完了（または失敗）にする。完了条件がすべて満たされていれば完了になる。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        status: { type: 'string', enum: ['done', 'failed'] },
        changedFiles: STRINGS,
        acceptance: {
          type: 'array',
          items: { type: 'object', properties: { item: { type: 'string' }, met: { type: 'boolean' } }, required: ['item', 'met'] },
        },
        discovered: { type: 'array', items: { type: 'object' }, description: '作業中に気づいた別の作業。ここでは登録しないので、別に pm_add で登録する' },
        notes: { type: 'string', description: 'failed のときは原因' },
      },
      required: ['taskId', 'status'],
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
  const summary = summarize(snapshot, snapshot.errors.length)
  await update($, summaryAtom, () => summary as LightpmSummary)
  await update($, boardAtom, () => boardRows(snapshot) as LightpmBoardRow[])
  return summary
}

const errorNote = (loaded: Loaded): string =>
  loaded.errors.length > 0 ? `\n\n注意: 読み込めなかったファイルがあります（/pm status で確認）:\n${loaded.errors.map(e => `- ${e}`).join('\n')}` : ''

/** 状態を変える操作：読み込み → コア → 書き込み → 帯の更新、を排他で行う。 */
const mutate = <T,>($: $, work: (repo: Repo, loaded: Loaded, now: string) => Promise<T>): Promise<T> =>
  exclusive(async () => {
    const repo = await repoOf($)
    const loaded = await repo.load()
    const now = await nowIso($)
    const result = await work(repo, loaded, now)
    await refresh($, repo)
    return result
  })

const answer = async (work: () => Promise<string>): Promise<{ result: string } | { deny: string }> => {
  try {
    return { result: await work() }
  } catch (e) {
    if (e instanceof InputError) return { deny: `LightPM: ${e.message}` }
    return { deny: `LightPM の内部エラー: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ---- /pm ----

const HELP = [
  '/pm [status]            フェーズ、作業中のタスク、一覧',
  '/pm init [phase]        .pm/ を作る（既定 alpha）',
  '/pm view                タスク一覧のペインを開く（優先順に並び、選んで展開できる）',
  '/pm next                次に選ばれるタスクを表示（状態は変えない）',
  '/pm list [status]       タスクの一覧（todo / in_progress / deferred / done / dropped）',
  '/pm why <id>            そのタスクが選ばれた・後回しになった理由',
  '/pm phase [set <phase> [理由]]  フェーズの表示・手動変更（監査ログに残る）',
  '/pm policy              フェーズポリシーの表',
  '/pm refresh             .pm/ を読み直して帯を更新',
].join('\n')

const runCommand = async ($: $, args: string): Promise<string> => {
  const [sub = 'status', ...rest] = args.trim().split(/\s+/).filter(s => s !== '')
  const repo = await repoOf($)
  if (sub === 'help') return HELP
  if (sub === 'init') {
    const phase = (rest[0] ?? 'alpha') as Phase
    if (!(PHASES as readonly string[]).includes(phase)) return `フェーズは ${PHASES.join(' / ')} のいずれかです。`
    const created = await exclusive(() => repo.init(phase))
    await refresh($, repo)
    return created ? `.pm/ を作りました（フェーズ ${phase}）。/lightpm:pm-plan で目的を分解して登録できます。` : '.pm/ は既にあります。'
  }
  if (!(await repo.exists())) return NOT_INITIALIZED
  const now = await nowIso($)
  switch (sub) {
    case 'view': {
      await refresh($, repo)
      const opened = await openBoard($)
      return opened.isPlaced ? 'タスク一覧を開きました（Esc で閉じる）。' : `タスク一覧を開けませんでした: ${opened.reason}`
    }
    case 'status': {
      const loaded = await repo.load()
      await refresh($, repo, loaded)
      return formatStatus(loaded, loaded.errors, nextTask(loaded, now, { dryRun: true }).result)
    }
    case 'next': {
      const loaded = await repo.load()
      return formatNext(nextTask(loaded, now, { dryRun: true }).result, true)
    }
    case 'list': {
      const loaded = await repo.load()
      return formatList(loaded.tasks, rest[0])
    }
    case 'why': {
      const id = rest[0]
      if (!id) return '使い方: /pm why T-0012'
      const loaded = await repo.load()
      return formatWhy(id, loaded.tasks.find(t => t.id === id), await repo.readLog())
    }
    case 'phase': {
      if (rest[0] !== 'set') {
        const loaded = await repo.load()
        return `現在のフェーズ: ${loaded.state.phase}（手動で変えるには /pm phase set <alpha|beta|rc|gm> [理由]）`
      }
      return mutate($, async (r, loaded, at) => {
        const outcome = setPhase(loaded, { phase: rest[1], reason: rest.slice(2).join(' ') }, at)
        await r.persist(outcome, at)
        return `フェーズを ${outcome.result.from} → ${outcome.result.to} に変えました（監査ログ: phase.set）。`
      }).catch(e => (e instanceof InputError ? e.message : String(e)))
    }
    case 'policy': {
      const loaded = await repo.load()
      return `着手できる下限（実効優先度）:\n${formatPolicy(loaded.config.policy)}`
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
    await $.command.register({ name: 'pm', description: 'LightPM: フェーズとタスクの状態（/pm help）', argumentHint: '[status|view|init|next|list|why|phase|policy|refresh]' })
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

  on('tool.call', { tool: 'mcp__lightpm__pm_status' }, async $ =>
    answer(async () => {
      const repo = await repoOf($)
      if (!(await repo.exists())) return NOT_INITIALIZED
      const loaded = await repo.load()
      await refresh($, repo, loaded)
      return formatStatus(loaded, loaded.errors, nextTask(loaded, await nowIso($), { dryRun: true }).result)
    }),
  )

  on('tool.call', { tool: 'mcp__lightpm__pm_next' }, async $ =>
    answer(async () => {
      const repo = await repoOf($)
      if (!(await repo.exists())) return NOT_INITIALIZED
      return mutate($, async (r, loaded, now) => {
        const outcome = nextTask(loaded, now)
        await r.persist(outcome, now)
        return formatNext(outcome.result) + errorNote(loaded)
      })
    }),
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
        const { task, notes } = outcome.result
        const status = task.status === 'deferred' && task.defer ? `後回し（${task.defer.reason} → ${task.defer.until}）` : task.status
        return [`登録: ${task.id} [${task.priority} ${task.kind}] ${task.title} — ${status}`, ...notes.map(n => `- ${n}`)].join('\n')
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
        const { task, notes } = outcome.result
        return [`更新: ${task.id} [${task.priority} ${task.kind}] ${task.title} — ${task.status}`, ...notes.map(n => `- ${n}`)].join('\n')
      })
    }),
  )

  on('tool.call', { tool: 'mcp__lightpm__pm_complete' }, async ($, e) =>
    answer(async () => {
      const repo = await repoOf($)
      if (!(await repo.exists())) return NOT_INITIALIZED
      return mutate($, async (r, loaded, now) => {
        const outcome = completeTask(loaded, e, now, actorOf(e))
        await r.persist(outcome, now)
        let text = formatComplete(outcome.result)
        const discovered = Array.isArray(e.discovered) ? e.discovered.length : 0
        if (discovered > 0) text += `\n\n報告に discovered が ${discovered} 件あります。pm-triage のルーブリックで分類して pm_add で登録してください。`
        return text
      })
    }),
  )

  // ---- 文脈・帯・記録 ----

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

  on('agent.spawn', async ($, e, next) => {
    const summary = (await $.state.get(SUMMARY)).value
    if (summary) {
      await exclusive(async () => {
        const repo = await repoOf($)
        if (!(await repo.exists())) return
        await repo.appendLog(
          [{ event: 'agent.spawn', actor: 'main', subagentType: e.subagentType, description: e.description, taskId: summary.active?.id ?? null }],
          await nowIso($),
        )
      }).catch(() => undefined)
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

  // ---- タスク一覧のペイン：優先順に並べ、選ぶと中身（やること）を展開する ----

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
    const toggle = (id: string) => () =>
      void update($, expandedAtom, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))

    const GROUPS = [
      { group: 'active', heading: '作業中' },
      { group: 'next', heading: '次にやる順' },
      { group: 'blocked', heading: '前提の完了待ち' },
      { group: 'later', heading: '後回し' },
    ] as const

    const row = (r: LightpmBoardRow, index: number) => {
      const isOpen = expanded.includes(r.id)
      const priority = r.eff === r.priority ? r.priority : `${r.priority}→${r.eff}`
      const number = r.group === 'next' ? `${index + 1}. ` : ''
      return (
        <Box key={`row:${r.id}`} flexDirection="column">
          <Button key={`t:${r.id}`} plain label={`${isOpen ? '▾' : '▸'} ${number}${r.id} [${priority}] ${r.title}`} onPress={toggle(r.id)} />
          {isOpen && (
            <Box key={`d:${r.id}`} flexDirection="column" paddingLeft={4}>
              <Text dimColor>やること（完了条件）</Text>
              {r.acceptance.map((item, i) => (
                <Text wrap="wrap">{`${i + 1}. ${item}`}</Text>
              ))}
              <Text dimColor wrap="wrap">{`種別 ${r.kind}${r.dependsOn.length > 0 ? ` · 前提 ${r.dependsOn.join(', ')}` : ''}${r.note ? ` · ${r.note}` : ''}`}</Text>
              {r.paths.length > 0 && <Text dimColor wrap="wrap">{`主なファイル: ${r.paths.join(', ')}`}</Text>}
              {r.body !== '' && <Text wrap="wrap">{r.body}</Text>}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">{`LightPM ${PHASE_LABEL[summary.phase]} · 完了 ${summary.counts.done}`}</Text>
        {rows.length === 0 && <Text dimColor>未完了のタスクはありません。/lightpm:pm-plan で登録できます。</Text>}
        {GROUPS.map(({ group, heading }) => {
          const list = rows.filter(r => r.group === group)
          if (list.length === 0) return null
          return (
            <Box key={`g:${group}`} flexDirection="column" marginTop={1}>
              <Text dimColor>{`${heading}（${list.length}）`}</Text>
              {list.map(row)}
            </Box>
          )
        })}
      </Box>
    )
  })
}
