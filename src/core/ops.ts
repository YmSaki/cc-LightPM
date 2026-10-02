// pm_add / pm_update。すべて純粋関数で、入力の形もここで確かめる。

import { Draft } from './draft.ts'
import type { Outcome } from './draft.ts'
import { bugPriority } from './priority.ts'
import { KINDS, PRIORITIES, SCHEMA, SEVERITIES, STATUSES, formatId, progressOf } from './types.ts'
import type { ChecklistItem, Priority, Severity, Snapshot, Task } from './types.ts'

export class InputError extends Error {}

const fail = (message: string): never => {
  throw new InputError(message)
}

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim()

const strings = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) fail(`${field} は文字列の配列で指定してください`)
  return (value as string[]).map(s => oneLine(s)).filter(s => s !== '')
}

const numbers = (value: unknown, field: string): number[] => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some(v => !Number.isInteger(v))) fail(`${field} は項目の番号（1 から）の配列で指定してください`)
  return value as number[]
}

const pick = <T extends string>(value: unknown, values: readonly T[], field: string): T | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T
  return fail(`${field} は ${values.join(' / ')} のいずれかです（${JSON.stringify(value)} は不可）`)
}

const checkDeps = (deps: string[] | undefined, self: string | null, tasks: Map<string, Task>): string[] => {
  const list = [...new Set(deps ?? [])]
  for (const dep of list) {
    if (dep === self) fail(`${dep} は自分自身に依存できません`)
    if (!tasks.has(dep)) fail(`depends_on の ${dep} は存在しません`)
  }
  return list
}

/** id の依存を deps に変えたとき循環するか。 */
const createsCycle = (id: string, deps: string[], tasks: Map<string, Task>): string[] | null => {
  const stack: { node: string; path: string[] }[] = deps.map(d => ({ node: d, path: [id, d] }))
  const seen = new Set<string>()
  while (stack.length > 0) {
    const { node, path } = stack.pop() as { node: string; path: string[] }
    if (node === id) return path
    if (seen.has(node)) continue
    seen.add(node)
    for (const next of tasks.get(node)?.depends_on ?? []) stack.push({ node: next, path: [...path, next] })
  }
  return null
}

/** バグの優先度を表から決める。影響先がタスクならその優先度、なければ impact_priority を使う。 */
const resolveBugPriority = (
  severity: Severity,
  impacts: string,
  impactPriority: Priority | undefined,
  tasks: Map<string, Task>,
): { priority: Priority; note: string } | null => {
  const impact = tasks.get(impacts)?.priority ?? impactPriority
  if (!impact) return null
  const priority = bugPriority(impact, severity)
  return { priority, note: `バグの表: 影響先 ${impacts}（${impact}）× ${severity} → ${priority}` }
}

// ---- pm_add ----

/** ツールの入力。モデルが渡すものなので、形はすべてここで確かめる。 */
export type Input = Readonly<Record<string, unknown>>

export type TaskResult = { task: Task; notes: string[] }

export const addTask = (snapshot: Snapshot, input: Input, now: string, actor = 'main'): Outcome<TaskResult> => {
  const draft = new Draft(snapshot, now)
  const notes: string[] = []
  const title = typeof input.title === 'string' ? oneLine(input.title) : ''
  if (title === '') fail('title は必須です（1行）')
  const kind = pick(input.kind, KINDS, 'kind') ?? fail('kind は必須です')
  const severity = pick(input.severity, SEVERITIES, 'severity')
  const impacts = typeof input.impacts === 'string' && input.impacts.trim() !== '' ? input.impacts.trim() : undefined
  let priority = pick(input.priority, PRIORITIES, 'priority')

  if (kind === 'bug') {
    if (!severity) fail('bug には severity（S0〜S3）が必須です')
    if (!impacts) fail('bug には impacts（影響を受けるタスク ID か機能名）が必須です')
    const fromTable = resolveBugPriority(severity as Severity, impacts as string, pick(input.impact_priority, PRIORITIES, 'impact_priority'), draft.tasks)
    if (fromTable) {
      if (priority && priority !== fromTable.priority) notes.push(`指定の priority ${priority} ではなく表の値を使った`)
      priority = fromTable.priority
      notes.push(fromTable.note)
    }
  }
  if (!priority) {
    fail(
      kind === 'bug'
        ? 'impacts が既存のタスクでないため、priority か impact_priority を指定してください'
        : 'priority は必須です（max / xhigh / high / mid / low / xlow）',
    )
  }

  const items = strings(input.checklist, 'checklist') ?? []
  if (items.length === 0) fail('checklist（やること）を1つ以上指定してください')
  const task: Task = {
    schema: SCHEMA,
    id: formatId(draft.state.nextId),
    title,
    kind,
    priority: priority as Priority,
    status: 'todo',
    depends_on: checkDeps(strings(input.depends_on, 'depends_on'), null, draft.tasks),
    checklist: items.map(text => ({ text, done: false })),
    created: now,
    updated: now,
    body: typeof input.body === 'string' ? input.body.trim() : '',
  }
  if (severity) task.severity = severity
  if (impacts) task.impacts = impacts

  draft.state.nextId += 1
  draft.put(task)
  draft.log({
    event: 'task.created',
    actor,
    taskId: task.id,
    kind,
    priority: task.priority,
    reason: typeof input.reason === 'string' && input.reason.trim() !== '' ? input.reason.trim() : null,
  })
  return draft.outcome({ task, notes })
}

// ---- pm_update ----

/** 理由が必要な変更（分類の変更）。変更履歴に旧値と新値と理由が残る。 */
const CLASSIFICATION = ['kind', 'priority', 'severity', 'impacts'] as const

/** 理由なしで変えられる内容。変更履歴には項目名だけが残る。 */
const CONTENT = ['title', 'body', 'notes', 'depends_on', 'checklist'] as const

/** チェックリストを置き換える。同じ文面の項目は済みの印を引き継ぐ。 */
const replaceChecklist = (before: ChecklistItem[], texts: string[]): ChecklistItem[] => {
  const done = new Set(before.filter(item => item.done).map(item => item.text))
  return texts.map(text => ({ text, done: done.has(text) }))
}

const setDone = (checklist: ChecklistItem[], indexes: number[], done: boolean): void => {
  for (const n of indexes) {
    const item = checklist[n - 1] ?? fail(`チェックリストに ${n} 番目の項目はありません（全 ${checklist.length} 項目）`)
    item.done = done
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export const updateTask = (snapshot: Snapshot, input: Input, now: string, actor = 'main'): Outcome<TaskResult> => {
  const draft = new Draft(snapshot, now)
  const notes: string[] = []
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const before = draft.tasks.get(id) ?? fail(`タスク ${id || '(id なし)'} は存在しません`)
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  const task = structuredClone(before)

  // 内容
  if (input.title !== undefined) {
    const title = typeof input.title === 'string' ? oneLine(input.title) : ''
    if (title === '') fail('title は空にできません')
    task.title = title
  }
  if (typeof input.body === 'string') task.body = input.body.trim()
  if (typeof input.notes === 'string') task.notes = oneLine(input.notes)
  const deps = strings(input.depends_on, 'depends_on')
  if (deps) {
    task.depends_on = checkDeps(deps, id, draft.tasks)
    const cycle = createsCycle(id, task.depends_on, draft.tasks)
    if (cycle) fail(`依存が循環します: ${cycle.join(' → ')}`)
  }

  // 分類
  const kind = pick(input.kind, KINDS, 'kind')
  if (kind) task.kind = kind
  const priority = pick(input.priority, PRIORITIES, 'priority')
  if (priority) task.priority = priority
  const severity = pick(input.severity, SEVERITIES, 'severity')
  if (severity) task.severity = severity
  if (typeof input.impacts === 'string' && input.impacts.trim() !== '') task.impacts = input.impacts.trim()
  if (task.kind === 'bug' && (severity || input.impacts !== undefined || kind) && task.severity && task.impacts) {
    const fromTable = resolveBugPriority(task.severity, task.impacts, pick(input.impact_priority, PRIORITIES, 'impact_priority'), draft.tasks)
    if (fromTable && fromTable.priority !== task.priority) {
      task.priority = fromTable.priority
      notes.push(fromTable.note)
    }
  }
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const key of CLASSIFICATION) {
    if (!same(before[key], task[key])) changes[key] = { from: before[key] ?? null, to: task[key] ?? null }
  }
  if (Object.keys(changes).length > 0 && reason === '') fail('種別や優先度を変えるときは reason（理由）が必須です。変更履歴に残します')

  // 進捗
  const items = strings(input.checklist, 'checklist')
  if (items) {
    if (items.length === 0) fail('checklist を空にはできません')
    task.checklist = replaceChecklist(task.checklist, items)
  }
  setDone(task.checklist, numbers(input.check, 'check'), true)
  setDone(task.checklist, numbers(input.uncheck, 'uncheck'), false)
  const progress = progressOf(task)
  const progressChanged = !same(progress, progressOf(before))
  const status = pick(input.status, STATUSES, 'status')
  if (status) {
    task.status = status
  } else if (progressChanged && task.status !== 'dropped') {
    // 状態を指定しなければ、チェックリストの進み具合から決める
    if (progress.total > 0 && progress.done === progress.total) task.status = 'done'
    else if (progress.done > 0) task.status = 'in_progress'
  }

  if (Object.keys(changes).length > 0) draft.log({ event: 'task.reclassified', actor, taskId: id, changes, reason })
  if (progressChanged) draft.log({ event: 'task.progress', actor, taskId: id, done: progress.done, total: progress.total })
  if (before.status !== task.status) {
    draft.log({ event: 'task.status', actor, taskId: id, from: before.status, to: task.status, reason: reason || null })
  }
  const edited = CONTENT.filter(key => !same(key === 'checklist' ? before.checklist.map(i => i.text) : before[key], key === 'checklist' ? task.checklist.map(i => i.text) : task[key]))
  if (edited.length > 0) draft.log({ event: 'task.updated', actor, taskId: id, fields: edited, reason: reason || null })

  draft.put(task)
  return draft.outcome({ task, notes })
}
