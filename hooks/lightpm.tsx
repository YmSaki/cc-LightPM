// LightPM のモッド。ツールとコマンドを登録し、.pm/ を読み書きし、帯とガードを出す。
// 判断はすべて src/core の純粋関数が行い、ここは入出力だけを受け持つ。

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { bandText, contextFor, formatComplete, formatList, formatNext, formatPolicy, formatStatus, formatWhy, summarize } from '../src/core/format.ts'
import type { Summary } from '../src/core/format.ts'
import { relativeTo } from '../src/core/glob.ts'
import { InputError, addTask, completeTask, judgeEdit, setPhase, updateTask } from '../src/core/ops.ts'
import type { Detected } from '../src/core/ops.ts'
import { nextTask } from '../src/core/select.ts'
import { ENFORCEMENTS, PHASES } from '../src/core/types.ts'
import type { Baseline, Phase, Snapshot } from '../src/core/types.ts'
import { Repo } from '../src/io/repo.ts'
import type { Loaded } from '../src/io/repo.ts'
import type { LightpmSummary } from '../types'

type $ = EngineInterface

const SUMMARY = { plugin: 'lightpm', key: 'summary' } as const
const summaryAtom = atom(SUMMARY, null)

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
  scope_paths: { ...STRINGS, description: '編集してよいパスの glob（ルートからの相対）。完了に必要な最小限。テストも含める。release 以外は必須' },
  acceptance: { ...STRINGS, description: '完了条件。1つ以上' },
  non_goals: { ...STRINGS, description: 'やらないこと' },
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
      'LightPM: タスクを1件登録する。作業中に見つけた範囲外の問題は、その場で直さずにこれで登録する。現在のフェーズで着手できないものは自動で後回し（deferred）になる。.pm/ がなければ作る。',
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
      'LightPM: pm-implementer の報告を渡してタスクを完了（または失敗）にする。完了条件と、変更ファイルが scope.paths に収まるか（git diff）を検証し、満たさなければ完了にしない。',
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
        discovered: { type: 'array', items: { type: 'object' }, description: '範囲外で見つけた問題。ここでは登録しないので、別に pm_add で登録する' },
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
    return null
  }
  const snapshot = loaded ?? (await repo.load())
  const previous = (await $.state.get(SUMMARY)).value
  const summary = summarize(snapshot, repo.root, previous?.violations ?? 0, snapshot.errors.length)
  await update($, summaryAtom, () => summary as LightpmSummary)
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

// ---- git（完了時の差分検証） ----

const git = ($: $, root: string, args: string[]) =>
  $.process.run(['git', '-c', 'core.quotepath=false', ...args], { cwd: root, timeoutMs: 15000 })

const nul = (out: string): string[] => out.split('\0').filter(s => s !== '')

const captureBaseline = async ($: $, root: string): Promise<Baseline | null> => {
  try {
    const inside = await git($, root, ['rev-parse', '--is-inside-work-tree'])
    if (inside.exitCode !== 0) return null
    const stash = await git($, root, ['stash', 'create'])
    let ref = stash.exitCode === 0 ? stash.stdout.trim() : ''
    if (ref === '') {
      const head = await git($, root, ['rev-parse', 'HEAD'])
      if (head.exitCode !== 0) return null
      ref = head.stdout.trim()
    }
    const untracked = await git($, root, ['ls-files', '-z', '--others', '--exclude-standard'])
    return { ref, untracked: untracked.exitCode === 0 ? nul(untracked.stdout) : [] }
  } catch {
    return null
  }
}

const detectChanges = async ($: $, root: string, baseline: Baseline | null | undefined): Promise<Detected> => {
  if (!baseline) return { files: null, source: 'none' }
  try {
    const diff = await git($, root, ['diff', '--name-only', '-z', '--no-renames', '--relative', baseline.ref])
    if (diff.exitCode !== 0) return { files: null, source: 'none', note: diff.stderr.trim() }
    const untracked = await git($, root, ['ls-files', '-z', '--others', '--exclude-standard'])
    const before = new Set(baseline.untracked)
    const added = untracked.exitCode === 0 ? nul(untracked.stdout).filter(f => !before.has(f)) : []
    return { files: [...nul(diff.stdout), ...added], source: 'git' }
  } catch (e) {
    return { files: null, source: 'none', note: String(e) }
  }
}

// ---- /pm ----

const HELP = [
  '/pm [status]            フェーズ、作業中のタスク、一覧',
  '/pm init [phase]        .pm/ を作る（既定 alpha）',
  '/pm next                次に選ばれるタスクを表示（状態は変えない）',
  '/pm list [status]       タスクの一覧（todo / in_progress / deferred / done / dropped）',
  '/pm why <id>            そのタスクが選ばれた・後回しになった理由',
  '/pm phase [set <phase> [理由]]  フェーズの表示・手動変更（監査ログに残る）',
  '/pm enforce <level>     ガードの強制レベル（off / inform / warn / block）',
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
    case 'enforce': {
      const level = rest[0]
      if (!level || !(ENFORCEMENTS as readonly string[]).includes(level)) return `強制レベルは ${ENFORCEMENTS.join(' / ')} のいずれかです。`
      return mutate($, async (r, loaded, at) => {
        const from = loaded.config.enforcement
        await r.saveConfig({ ...loaded.config, enforcement: level as Snapshot['config']['enforcement'] })
        await r.appendLog([{ event: 'config.changed', actor: 'user', key: 'enforcement', from, to: level }], at)
        return `ガードの強制レベルを ${from} → ${level} にしました。`
      })
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

// ---- ガード ----

const guard = async ($: $, e: { agentId?: string }, path: string): Promise<{ deny: string } | { warn: string } | null> => {
  const summary = (await $.state.get(SUMMARY)).value
  if (!summary || summary.enforcement === 'off') return null
  const rel = relativeTo(summary.root, path)
  const verdict = judgeEdit({ path: rel, active: summary.active ? { id: summary.active.id, paths: summary.active.paths } : null })
  if (!verdict.violation) return null
  const level = summary.enforcement
  const result = level === 'block' ? 'deny' : 'allow'
  await exclusive(async () => {
    const repo = await repoOf($)
    if (!(await repo.exists())) return
    await repo.appendLog(
      [{ event: 'guard.violation', actor: actorOf(e), taskId: verdict.taskId, path: rel, kind: verdict.kind, level, result }],
      await nowIso($),
    )
  })
  await update($, summaryAtom, s => (s ? { ...s, violations: s.violations + 1 } : s))
  if (level === 'block') return { deny: verdict.message }
  if (level === 'warn') {
    $.ui.toast(verdict.message, { timeoutMs: 6000 })
    return { warn: verdict.message }
  }
  return null
}

// ---- 登録 ----

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const tool of TOOLS) await $.tool.register(tool)
    await $.command.register({ name: 'pm', description: 'LightPM: フェーズとタスクの状態（/pm help）', argumentHint: '[status|init|next|list|why|phase|enforce|policy|refresh]' })
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
        if (outcome.result.kind === 'task' && !outcome.result.resumed) {
          outcome.state.baseline = await captureBaseline($, r.root)
        }
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
        const detected = loaded.config.scopeVerify ? await detectChanges($, r.root, loaded.state.baseline) : { files: null, source: 'none' as const }
        const outcome = completeTask(loaded, e, detected, now, actorOf(e))
        await r.persist(outcome, now)
        let text = formatComplete(outcome.result)
        const discovered = Array.isArray(e.discovered) ? e.discovered.length : 0
        if (discovered > 0) text += `\n\n報告に discovered が ${discovered} 件あります。直さずに pm_add で登録してください（pm-triage のルーブリックで分類）。`
        return text
      })
    }),
  )

  // ---- ガード：Edit / Write / NotebookEdit ----

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const verdict = await guard($, e, e.file_path)
    if (verdict && 'deny' in verdict) return { deny: verdict.deny }
    const ran = await next(e)
    return verdict && ran.deny === undefined ? { ...ran, context: [...(ran.context ?? []), verdict.warn] } : ran
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const verdict = await guard($, e, e.file_path)
    if (verdict && 'deny' in verdict) return { deny: verdict.deny }
    const ran = await next(e)
    return verdict && ran.deny === undefined ? { ...ran, context: [...(ran.context ?? []), verdict.warn] } : ran
  })

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const verdict = await guard($, e, e.notebook_path)
    if (verdict && 'deny' in verdict) return { deny: verdict.deny }
    const ran = await next(e)
    return verdict && ran.deny === undefined ? { ...ran, context: [...(ran.context ?? []), verdict.warn] } : ran
  })

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
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          {bandText(summary)}
        </Text>
      </Box>
    )
  })
}
