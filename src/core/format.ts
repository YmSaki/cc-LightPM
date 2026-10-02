// 人と Claude が読む文面。ツールの結果、/pm の出力、プロンプトに足す文脈、帯の1行。

import { serializeTask } from './frontmatter.ts'
import { DEFAULT_POLICY, resolvePolicy } from './policy.ts'
import { byId, effectivePriorities, exitCheck } from './select.ts'
import type { NextResult } from './select.ts'
import type { CompleteResult } from './ops.ts'
import { PHASES, STATUSES, priorityAt } from './types.ts'
import type { Phase, Snapshot, Status, Task } from './types.ts'

export type Summary = {
  phase: Phase
  active: { id: string; title: string; priority: string; kind: string; paths: string[] } | null
  counts: Record<Status, number>
  errors: number
}

export const PHASE_LABEL: Record<Phase, string> = { alpha: 'Alpha', beta: 'Beta', rc: 'RC', gm: 'GM' }

export const summarize = (snapshot: Snapshot, errors: number): Summary => {
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0])) as Record<Status, number>
  for (const t of snapshot.tasks) counts[t.status] += 1
  const active = snapshot.state.active ? snapshot.tasks.find(t => t.id === snapshot.state.active) : undefined
  return {
    phase: snapshot.state.phase,
    active: active
      ? { id: active.id, title: active.title, priority: active.priority, kind: active.kind, paths: active.scope.paths }
      : null,
    counts,
    errors,
  }
}

const HOW = [
  'acceptance をすべて満たしたら完了。scope.paths は主に触るファイルの目安',
  '作業中に気づいた別の作業は、報告の discovered に書く。登録されて優先度順に回ってくる',
]

/** pm-implementer に渡すタスク契約。 */
export const taskContract = (task: Task, phase: Phase): string =>
  [
    `## タスク契約 ${task.id}（フェーズ: ${PHASE_LABEL[phase]}）`,
    '',
    '```markdown',
    serializeTask(task).trimEnd(),
    '```',
    '',
    '進め方:',
    ...HOW.map(r => `- ${r}`),
    '',
    '報告の形式（pm_complete にそのまま渡す）:',
    '```json',
    JSON.stringify(
      {
        taskId: task.id,
        status: 'done | failed',
        changedFiles: ['変更したファイル（ルートからの相対パス）'],
        acceptance: task.acceptance.map(item => ({ item, met: true })),
        discovered: [{ title: '作業中に気づいた別の作業', kind: 'bug', severity: 'S2', impacts: task.id }],
        notes: 'failed のときは原因',
      },
      null,
      2,
    ),
    '```',
  ].join('\n')

const line = (t: Task): string =>
  `${t.id} [${t.priority} ${t.kind}] ${t.title}${t.defer ? `（後回し: ${t.defer.reason} → ${t.defer.until}）` : ''}`

export const formatNext = (result: NextResult, dryRun = false): string => {
  const out: string[] = []
  for (const a of result.phaseAdvanced) out.push(`フェーズを ${PHASE_LABEL[a.from]} → ${PHASE_LABEL[a.to]} に進めた。`)
  if (result.kind !== 'done') {
    if (result.restored.length > 0) out.push(`todo に戻した: ${result.restored.join(', ')}`)
    if (result.deferred.length > 0) {
      out.push(`後回しにした: ${result.deferred.map(d => `${d.id}（${d.reason} → ${d.until}）`).join(', ')}`)
    }
  }
  if (result.kind === 'done') {
    out.push('完了: GM の release タスクがすべて終わった。プロジェクトは完了です。ループを終えてください。')
    return out.join('\n')
  }
  if (result.kind === 'wait') {
    out.push('待ち: 着手できるタスクがありません。ループを終えて人に報告してください。')
    out.push(...result.reasons.map(r => `- ${r}`))
    return out.join('\n')
  }
  const { task } = result
  if (dryRun) {
    out.push(`次に選ばれるタスク: ${line(task)}`)
  } else if (result.resumed) {
    out.push(`作業中のタスクを再開: ${line(task)}`)
  } else {
    out.push(`選択: ${line(task)}`)
  }
  if (result.trace) {
    out.push(
      `根拠: 候補 ${result.trace.candidates} 件、着手可能 ${result.trace.eligible} 件。上位: ${result.trace.top
        .map(k => `${k.id}(eff=${k.eff}, blocks=${k.blocks}${k.main ? ', 主役' : ''}, est=${k.estimate})`)
        .join(' > ')}`,
    )
  }
  if (!dryRun) {
    out.push('')
    out.push(taskContract(task, result.phase))
  }
  return out.join('\n')
}

export const formatStatus = (snapshot: Snapshot, errors: readonly string[], dryRunNext?: NextResult): string => {
  const { state, tasks } = snapshot
  const sorted = [...tasks].sort(byId)
  const eff = effectivePriorities(sorted)
  const count = (s: Status): number => sorted.filter(t => t.status === s).length
  const out: string[] = [
    `LightPM — フェーズ ${PHASE_LABEL[state.phase]}`,
    `タスク: todo ${count('todo')} / 作業中 ${count('in_progress')} / 後回し ${count('deferred')} / 完了 ${count('done')} / 取り下げ ${count('dropped')}`,
  ]
  const active = state.active ? sorted.find(t => t.id === state.active) : undefined
  out.push(active ? `作業中: ${line(active)}` : '作業中: なし')
  if (dryRunNext) {
    if (dryRunNext.kind === 'task' && !dryRunNext.resumed) out.push(`次の候補: ${line(dryRunNext.task)}`)
    if (dryRunNext.kind === 'wait') out.push('次の候補: なし（待ち）')
    if (dryRunNext.kind === 'done') out.push('次の候補: なし（完了）')
  }
  const exit = exitCheck(state.phase, sorted)
  out.push(
    `${PHASE_LABEL[state.phase]} を抜ける条件: ${exit.condition} — ${exit.ok ? '満たしている' : `残り ${exit.blocking.length} 件（${exit.blocking.slice(0, 5).map(t => t.id).join(', ')}${exit.blocking.length > 5 ? ' …' : ''}）`}`,
  )
  const todo = sorted.filter(t => t.status === 'todo')
  if (todo.length > 0) {
    out.push('', 'todo:')
    for (const t of todo.slice(0, 20)) {
      const e = eff.get(t.id) ?? 0
      const effText = priorityAt(e) !== t.priority ? `（実効 ${priorityAt(e)}）` : ''
      const deps = t.depends_on.length > 0 ? ` ← ${t.depends_on.join(', ')}` : ''
      out.push(`- ${line(t)}${effText}${deps}`)
    }
    if (todo.length > 20) out.push(`- …ほか ${todo.length - 20} 件`)
  }
  const deferred = sorted.filter(t => t.status === 'deferred')
  if (deferred.length > 0) {
    out.push('', '後回し:')
    for (const t of deferred.slice(0, 20)) out.push(`- ${line(t)}`)
    if (deferred.length > 20) out.push(`- …ほか ${deferred.length - 20} 件`)
  }
  if (errors.length > 0) {
    out.push('', '読み込めなかったファイル:')
    for (const e of errors) out.push(`- ${e}`)
  }
  return out.join('\n')
}

export const formatList = (tasks: readonly Task[], status?: string): string => {
  const list = [...tasks].sort(byId).filter(t => !status || t.status === status)
  if (list.length === 0) return 'タスクはありません。'
  return list.map(t => `${t.status.padEnd(11)} ${line(t)}`).join('\n')
}

export const formatComplete = (result: CompleteResult): string => {
  switch (result.kind) {
    case 'completed':
      return [
        `${result.task.id} を完了にした。`,
        '報告の discovered があれば pm_add で登録してから、pm_next で次のタスクを取得してください。',
      ].join('\n')
    case 'failed':
      return result.stop
        ? `${result.task.id} は ${result.failures} 回続けて失敗したため todo に戻した。ループを止めて人に報告してください。`
        : `${result.task.id} を失敗として todo に戻した（${result.failures} 回目）。pm_next でもう一度取得できます。`
    case 'incomplete':
      return [
        `${result.task.id} はまだ完了ではありません。残っている完了条件:`,
        ...result.unmet.map(u => `- ${u}`),
        '作業を続けるか、満たせないなら status: failed で報告してください。',
      ].join('\n')
  }
}

/** 毎回のプロンプトに足す文脈（600 文字以内）。 */
export const contextFor = (summary: Summary): string => {
  const head = `[LightPM] フェーズ ${PHASE_LABEL[summary.phase]}。`
  const body = summary.active
    ? `今やること: ${summary.active.id}「${summary.active.title}」（${summary.active.priority} ${summary.active.kind}）。終わったら mcp__lightpm__pm_complete で報告し、mcp__lightpm__pm_next で次を取る。気づいた別の作業は mcp__lightpm__pm_add で登録すれば、優先度順に回ってくる。`
    : `作業中のタスクはない（todo ${summary.counts.todo}、後回し ${summary.counts.deferred}）。作業を始めるなら mcp__lightpm__pm_next で次のタスクを取る。新しい作業は mcp__lightpm__pm_add で登録する。`
  const text = head + body
  return text.length <= 600 ? text : `${text.slice(0, 599)}…`
}

export const bandText = (summary: Summary): string => {
  const active = summary.active ? `▶ ${summary.active.id} ${summary.active.title} [${summary.active.priority}]` : '作業中なし'
  const errors = summary.errors > 0 ? ` · 読込エラー ${summary.errors}` : ''
  return `LightPM ${PHASE_LABEL[summary.phase]} · ${active} · todo ${summary.counts.todo} · 後回し ${summary.counts.deferred} · 完了 ${summary.counts.done}${errors}`
}

/** /pm why：監査ログからそのタスクが選ばれた、または後回しになった理由を出す。 */
export const formatWhy = (taskId: string, task: Task | undefined, events: readonly Record<string, unknown>[]): string => {
  const out: string[] = []
  out.push(task ? `${line(task)}（status: ${task.status}）` : `${taskId} は見つかりません。`)
  const mine = events.filter(e => e.taskId === taskId || (e.event === 'task.selected' && hasInTop(e, taskId)))
  if (mine.length === 0) {
    out.push('監査ログに記録がありません。')
    return out.join('\n')
  }
  for (const e of mine) {
    const ts = String(e.ts ?? '')
    switch (e.event) {
      case 'task.created':
        out.push(`${ts} 登録: ${e.kind} / ${e.priority}${e.reason ? ` — ${e.reason}` : ''}`)
        break
      case 'task.selected': {
        const trace = e.trace as { candidates: number; eligible: number; top: { id: string; eff: string; blocks: number }[] }
        if (e.taskId === taskId) {
          out.push(
            `${ts} 選択: 候補 ${trace.candidates} 件、着手可能 ${trace.eligible} 件で先頭（${trace.top.map(k => `${k.id} eff=${k.eff} blocks=${k.blocks}`).join(' > ')}）`,
          )
        } else {
          const me = trace.top.find(k => k.id === taskId)
          out.push(`${ts} ${String(e.taskId)} が先に選ばれた（こちらは eff=${me?.eff} blocks=${me?.blocks}）`)
        }
        break
      }
      case 'task.deferred':
        out.push(`${ts} 後回し: ${e.phase} では ${e.reason}（実効 ${e.eff}）→ ${e.until} から着手可`)
        break
      case 'task.restored':
        out.push(`${ts} todo に戻った（${e.phase} で着手可能になった）`)
        break
      case 'task.reclassified':
        out.push(`${ts} 再分類: ${JSON.stringify(e.changes)} — ${e.reason}`)
        break
      case 'task.completed':
        out.push(`${ts} 完了`)
        break
      case 'task.failed':
        out.push(`${ts} 失敗 ${e.failures} 回目${e.notes ? `: ${e.notes}` : ''}`)
        break
      default:
        out.push(`${ts} ${String(e.event)}`)
    }
  }
  return out.join('\n')
}

const hasInTop = (e: Record<string, unknown>, id: string): boolean => {
  const trace = e.trace as { top?: { id: string }[] } | undefined
  return trace?.top?.some(k => k.id === id) ?? false
}

/** 既定のポリシー表（/pm policy 用）。 */
export const formatPolicy = (override: Snapshot['config']['policy']): string => {
  const policy = resolvePolicy(override)
  const kinds = Object.keys(DEFAULT_POLICY.alpha) as (keyof (typeof DEFAULT_POLICY)['alpha'])[]
  const rows = PHASES.map(phase => {
    const cells = kinds.map(kind => {
      const rule = policy[phase][kind]
      if (rule.min === null) return rule.blocker ? '阻害のみ' : '不可'
      return `${rule.min}+${rule.blocker ? '/阻害' : ''}`
    })
    return `| ${PHASE_LABEL[phase]} | ${cells.join(' | ')} |`
  })
  return [`| フェーズ | ${kinds.join(' | ')} |`, `| --- | ${kinds.map(() => '---').join(' | ')} |`, ...rows].join('\n')
}
