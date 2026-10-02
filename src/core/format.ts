// 人と Claude が読む文面。ツールの結果、/pm の出力、プロンプトに足す文脈、帯の1行、一覧の行。

import { byPriority, sortTasks } from './priority.ts'
import { STATUSES, progressOf } from './types.ts'
import type { ChecklistItem, Status, Task } from './types.ts'

export const STATUS_LABEL: Record<Status, string> = {
  todo: '未着手',
  in_progress: '作業中',
  done: '完了',
  dropped: '取り下げ',
}

const progressText = (t: Task): string => {
  const { done, total } = progressOf(t)
  return total > 0 ? `${done}/${total}` : ''
}

const head = (t: Task): string => `${t.id} [${t.priority} ${t.kind}] ${t.title}`

/** 前提のタスクを「T-0002（完了）」の形で並べる。存在しない id は「不明」とする。 */
const depsText = (t: Task, byKey: Map<string, Task>): string =>
  t.depends_on.map(dep => `${dep}（${byKey.has(dep) ? STATUS_LABEL[(byKey.get(dep) as Task).status] : '不明'}）`).join(', ')

const line = (t: Task, byKey: Map<string, Task>): string => {
  const parts = [head(t)]
  const progress = progressText(t)
  if (progress) parts.push(progress)
  if (t.depends_on.length > 0) parts.push(`前提: ${depsText(t, byKey)}`)
  return parts.join('  ')
}

// ---- 帯とプロンプトに使う要約 ----

export type Summary = {
  active: { id: string; title: string; priority: string; progress: { done: number; total: number } }[]
  top: { id: string; title: string; priority: string } | null
  counts: Record<Status, number>
  errors: number
}

export const summarize = (tasks: readonly Task[], errors: number): Summary => {
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0])) as Record<Status, number>
  for (const t of tasks) counts[t.status] += 1
  const sorted = sortTasks(tasks)
  const top = sorted.find(t => t.status === 'todo')
  return {
    active: sorted.filter(t => t.status === 'in_progress').map(t => ({ id: t.id, title: t.title, priority: t.priority, progress: progressOf(t) })),
    top: top ? { id: top.id, title: top.title, priority: top.priority } : null,
    counts,
    errors,
  }
}

/** プロンプトに足す文脈の上限（文字数）。切り詰めるときは末尾の「…」を含めてこの長さに収める。 */
const CONTEXT_LIMIT = 600

/** 毎回のプロンプトに足す文脈（CONTEXT_LIMIT 文字以内）。 */
export const contextFor = (summary: Summary): string => {
  const parts = ['[LightPM]']
  if (summary.active.length > 0) {
    const list = summary.active.map(a => `${a.id}「${a.title}」（${a.priority}${a.progress.total > 0 ? `、${a.progress.done}/${a.progress.total}` : ''}）`)
    parts.push(`作業中: ${list.join('、')}。`)
    parts.push('やることを終えたら mcp__lightpm__pm_update の check で済みにする（全部済むと完了になる）。')
  } else {
    parts.push(`作業中のタスクはない（未着手 ${summary.counts.todo}）。`)
    if (summary.top) parts.push(`最優先の未着手は ${summary.top.id}「${summary.top.title}」（${summary.top.priority}）。`)
    parts.push('着手するときは mcp__lightpm__pm_update で status を in_progress にする。')
  }
  parts.push('気づいた別の作業は mcp__lightpm__pm_add で登録する。')
  const text = parts.join('')
  return text.length <= CONTEXT_LIMIT ? text : `${text.slice(0, CONTEXT_LIMIT - 1)}…`
}

export const bandText = (summary: Summary): string => {
  const first = summary.active[0]
  const now = first
    ? `▶ ${first.id} ${first.title} [${first.priority}]${first.progress.total > 0 ? ` ${first.progress.done}/${first.progress.total}` : ''}${summary.active.length > 1 ? ` ほか${summary.active.length - 1}件` : ''}`
    : summary.top
      ? `次: ${summary.top.id} ${summary.top.title} [${summary.top.priority}]`
      : 'タスクなし'
  const errors = summary.errors > 0 ? ` · 読込エラー ${summary.errors}` : ''
  return `LightPM · ${now} · 作業中 ${summary.counts.in_progress} · 未着手 ${summary.counts.todo} · 完了 ${summary.counts.done}${errors}`
}

// ---- 一覧のペインに渡す行 ----

export type BoardGroup = 'active' | 'todo' | 'done'

/** タスク一覧のペインに渡す行（$.state に置く素のデータ）。 */
export type BoardRow = {
  id: string
  title: string
  kind: string
  priority: string
  status: Status
  group: BoardGroup
  progress: { done: number; total: number }
  checklist: ChecklistItem[]
  dependsOn: { id: string; status: string }[]
  severity: string | null
  impacts: string | null
  body: string
}

const BOARD_LIMIT = 300
const BODY_LIMIT = 400

const byUpdatedDesc = (a: Task, b: Task): number => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : byPriority(a, b))

/** 作業中 → 未着手（優先度順）→ 完了（新しい順）。取り下げは出さない。 */
export const boardRows = (tasks: readonly Task[]): BoardRow[] => {
  const byKey = new Map(tasks.map(t => [t.id, t]))
  const sorted = sortTasks(tasks)
  const groups: [BoardGroup, Task[]][] = [
    ['active', sorted.filter(t => t.status === 'in_progress')],
    ['todo', sorted.filter(t => t.status === 'todo')],
    ['done', tasks.filter(t => t.status === 'done').sort(byUpdatedDesc)],
  ]
  return groups
    .flatMap(([group, list]) =>
      list.map(t => ({
        id: t.id,
        title: t.title,
        kind: t.kind,
        priority: t.priority,
        status: t.status,
        group,
        progress: progressOf(t),
        checklist: t.checklist,
        dependsOn: t.depends_on.map(dep => ({ id: dep, status: byKey.has(dep) ? STATUS_LABEL[(byKey.get(dep) as Task).status] : '不明' })),
        severity: t.severity ?? null,
        impacts: t.impacts ?? null,
        body: t.body.length > BODY_LIMIT ? `${t.body.slice(0, BODY_LIMIT)}…` : t.body,
      })),
    )
    .slice(0, BOARD_LIMIT)
}

// ---- ツールと /pm の出力 ----

export type ListFilter = 'open' | 'all' | Status

/** どんなタスクがあるか。状態ごとに、優先度の高い順に並べる。 */
export const formatList = (tasks: readonly Task[], filter: ListFilter = 'open', errors: readonly string[] = []): string => {
  const byKey = new Map(tasks.map(t => [t.id, t]))
  const sorted = sortTasks(tasks)
  const statuses: Status[] = filter === 'open' ? ['in_progress', 'todo'] : filter === 'all' ? [...STATUSES] : [filter]
  const out: string[] = []
  for (const status of statuses) {
    // 完了は新しく完了したものから、それ以外は優先度の高い順
    const list = status === 'done' ? tasks.filter(t => t.status === 'done').sort(byUpdatedDesc) : sorted.filter(t => t.status === status)
    if (list.length === 0) continue
    if (out.length > 0) out.push('')
    out.push(`${STATUS_LABEL[status]}（${list.length}）`)
    out.push(...list.map(t => `- ${line(t, byKey)}`))
  }
  if (out.length === 0) out.push(filter === 'open' ? '未完了のタスクはありません。' : 'タスクはありません。')
  if (filter === 'open') {
    const done = tasks.filter(t => t.status === 'done').length
    if (done > 0) out.push('', `完了 ${done} 件（/pm list done で表示）`)
  }
  if (errors.length > 0) out.push('', '読み込めなかったファイル:', ...errors.map(e => `- ${e}`))
  return out.join('\n')
}

/** 何をするタスクか。説明、やること（チェックリスト）、前提、メモ。 */
export const formatShow = (task: Task, tasks: readonly Task[]): string => {
  const byKey = new Map(tasks.map(t => [t.id, t]))
  const progress = progressText(task)
  const out = [`${head(task)}（${STATUS_LABEL[task.status]}${progress ? `、${progress}` : ''}）`]
  if (task.depends_on.length > 0) out.push(`前提: ${depsText(task, byKey)}`)
  if (task.severity || task.impacts) out.push(`重大度 ${task.severity ?? '-'}、影響 ${task.impacts ?? '-'}`)
  if (task.body !== '') out.push('', task.body)
  out.push('', 'やること:')
  task.checklist.forEach((item, i) => out.push(`[${item.done ? 'x' : ' '}] ${i + 1}. ${item.text}`))
  if (task.notes) out.push('', `メモ: ${task.notes}`)
  return out.join('\n')
}

export const formatSaved = (verb: string, task: Task, notes: readonly string[]): string => {
  const progress = progressText(task)
  return [`${verb}: ${head(task)} — ${STATUS_LABEL[task.status]}${progress ? ` ${progress}` : ''}`, ...notes.map(n => `- ${n}`)].join('\n')
}

/** /pm why：そのタスクの変更履歴を、監査ログから時系列で出す。 */
export const formatWhy = (taskId: string, task: Task | undefined, events: readonly Record<string, unknown>[]): string => {
  const out: string[] = [task ? `${head(task)}（${STATUS_LABEL[task.status]}）` : `${taskId} は見つかりません。`]
  const mine = events.filter(e => e.taskId === taskId)
  if (mine.length === 0) {
    out.push('変更履歴はありません。')
    return out.join('\n')
  }
  for (const e of mine) {
    const ts = String(e.ts ?? '')
    const why = typeof e.reason === 'string' && e.reason !== '' ? ` — ${e.reason}` : ''
    switch (e.event) {
      case 'task.created':
        out.push(`${ts} 登録: ${e.kind} / ${e.priority}${why}`)
        break
      case 'task.reclassified': {
        const changes = Object.entries(e.changes as Record<string, { from: unknown; to: unknown }>)
          .map(([key, c]) => `${key} ${c.from ?? '-'} → ${c.to ?? '-'}`)
          .join('、')
        out.push(`${ts} 分類の変更: ${changes}${why}`)
        break
      }
      case 'task.status':
        out.push(`${ts} 状態: ${STATUS_LABEL[e.from as Status] ?? e.from} → ${STATUS_LABEL[e.to as Status] ?? e.to}${why}`)
        break
      case 'task.progress':
        out.push(`${ts} 進捗: ${e.done}/${e.total}`)
        break
      case 'task.updated':
        out.push(`${ts} 内容の変更: ${(e.fields as string[]).join('、')}${why}`)
        break
      default:
        out.push(`${ts} ${String(e.event)}`)
    }
  }
  return out.join('\n')
}

