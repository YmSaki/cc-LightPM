// pm_add / pm_update / pm_complete / フェーズ変更。すべて純粋関数。

import { admits, bugPriority, deferUntil } from './policy.ts'
import { Draft, effectivePriorities } from './select.ts'
import type { Outcome } from './select.ts'
import {
  ESTIMATES,
  KINDS,
  PHASES,
  PRIORITIES,
  SCHEMA,
  SEVERITIES,
  formatId,
  ordinal,
} from './types.ts'
import type { Estimate, Phase, Priority, Severity, Snapshot, Task } from './types.ts'

export class InputError extends Error {}

const fail = (message: string): never => {
  throw new InputError(message)
}

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim()

const normalizePath = (path: string): string =>
  path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/$/, '')

const strings = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) fail(`${field} は文字列の配列で指定してください`)
  return (value as string[]).map(s => s.trim()).filter(s => s !== '')
}

const pick = <T extends string>(value: unknown, values: readonly T[], field: string): T | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T
  return fail(`${field} は ${values.join(' / ')} のいずれかです（${JSON.stringify(value)} は不可）`)
}

/** 主に触るファイルの目安。作業する側への手がかりで、制限ではない。 */
const toPaths = (paths: string[] | undefined): string[] => (paths ?? []).map(normalizePath).filter(p => p !== '')

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

const isLate = (phase: Phase): boolean => phase === 'rc' || phase === 'gm'

/** バグの優先度を表から決める。影響先がタスクならその優先度、なければ impact_priority を使う。 */
const resolveBugPriority = (
  severity: Severity,
  impacts: string,
  impactPriority: Priority | undefined,
  tasks: Map<string, Task>,
): { priority: Priority; note: string } | null => {
  const target = tasks.get(impacts)
  const impact = target?.priority ?? impactPriority
  if (!impact) return null
  const priority = bugPriority(impact, severity)
  return { priority, note: `バグの表: 影響先 ${impacts}（${impact}）× ${severity} → ${priority}` }
}

// ---- pm_add ----

/** ツールの入力。モデルが渡すものなので、形はすべてここで確かめる。 */
export type AddInput = Readonly<Record<string, unknown>>

export type AddResult = { task: Task; notes: string[] }

export const addTask = (snapshot: Snapshot, input: AddInput, now: string, actor = 'main'): Outcome<AddResult> => {
  const draft = new Draft(snapshot, now)
  const notes: string[] = []
  const title = typeof input.title === 'string' ? oneLine(input.title) : ''
  if (title === '') fail('title は必須です（1行）')
  const kind = pick(input.kind, KINDS, 'kind') ?? fail('kind は必須です')
  const severity = pick(input.severity, SEVERITIES, 'severity')
  const impacts = typeof input.impacts === 'string' && input.impacts.trim() !== '' ? input.impacts.trim() : undefined
  const estimate = pick(input.estimate, ESTIMATES, 'estimate') as Estimate | undefined
  let priority = pick(input.priority, PRIORITIES, 'priority')

  if (kind === 'bug') {
    if (!severity) fail('bug には severity（S0〜S3）が必須です')
    if (!impacts) fail('bug には impacts（影響を受けるタスク ID か機能名）が必須です')
    const fromTable = resolveBugPriority(
      severity as Severity,
      impacts as string,
      pick(input.impact_priority, PRIORITIES, 'impact_priority'),
      draft.tasks,
    )
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

  const acceptance = strings(input.acceptance, 'acceptance') ?? []
  if (acceptance.length === 0) fail('acceptance（完了条件）を1つ以上指定してください')
  const id = formatId(draft.state.nextId)
  const task: Task = {
    schema: SCHEMA,
    id,
    title,
    kind,
    priority: priority as Priority,
    status: 'todo',
    depends_on: checkDeps(strings(input.depends_on, 'depends_on'), null, draft.tasks),
    scope: { paths: toPaths(strings(input.scope_paths, 'scope_paths')) },
    acceptance,
    non_goals: strings(input.non_goals, 'non_goals') ?? [],
    created: now,
    updated: now,
    body: typeof input.body === 'string' ? input.body.trim() : '',
  }
  if (estimate) task.estimate = estimate
  if (severity) task.severity = severity
  if (impacts) task.impacts = impacts
  if (input.release_blocker === true) task.release_blocker = true

  const phase = draft.state.phase
  if (kind === 'bug' && isLate(phase) && ordinal(task.priority) >= ordinal('xhigh') && !task.release_blocker) {
    task.release_blocker = true
    notes.push(`${phase} で ${task.priority} のバグなので release_blocker を付けた`)
  }

  draft.state.nextId += 1
  const admission = admits(draft.policy, phase, task, ordinal(task.priority))
  draft.put(task)
  draft.log({
    event: 'task.created',
    actor,
    taskId: id,
    kind,
    priority: task.priority,
    reason: typeof input.reason === 'string' ? input.reason : null,
  })
  if (!admission.ok) {
    const until = deferUntil(draft.policy, phase, task, ordinal(task.priority))
    task.status = 'deferred'
    task.defer = { until, reason: admission.reason }
    draft.log({ event: 'task.deferred', taskId: id, phase, until, reason: admission.reason, eff: task.priority })
    notes.push(`${phase} では着手できないため後回し（${admission.reason}、${until} から）`)
  }
  return draft.outcome({ task, notes })
}

// ---- pm_update ----

export type UpdateInput = Readonly<Record<string, unknown>>

const CLASSIFICATION = ['kind', 'priority', 'severity', 'impacts', 'depends_on', 'scope', 'release_blocker', 'estimate'] as const

export const updateTask = (snapshot: Snapshot, input: UpdateInput, now: string, actor = 'main'): Outcome<AddResult> => {
  const draft = new Draft(snapshot, now)
  const notes: string[] = []
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const before = draft.tasks.get(id) ?? fail(`タスク ${id || '(id なし)'} は存在しません`)
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason === '') fail('reason（変更の理由）は必須です。監査ログに残します')
  const task = structuredClone(before)

  if (input.title !== undefined) {
    const title = typeof input.title === 'string' ? oneLine(input.title) : ''
    if (title === '') fail('title は空にできません')
    task.title = title
  }
  const kind = pick(input.kind, KINDS, 'kind')
  if (kind) task.kind = kind
  const priority = pick(input.priority, PRIORITIES, 'priority')
  if (priority) task.priority = priority
  const severity = pick(input.severity, SEVERITIES, 'severity')
  if (severity) task.severity = severity
  if (typeof input.impacts === 'string' && input.impacts.trim() !== '') task.impacts = input.impacts.trim()
  const estimate = pick(input.estimate, ESTIMATES, 'estimate')
  if (estimate) task.estimate = estimate
  if (typeof input.release_blocker === 'boolean') {
    if (input.release_blocker) task.release_blocker = true
    else delete task.release_blocker
  }
  const deps = strings(input.depends_on, 'depends_on')
  if (deps) {
    task.depends_on = checkDeps(deps, id, draft.tasks)
    const cycle = createsCycle(id, task.depends_on, draft.tasks)
    if (cycle) fail(`依存が循環します: ${cycle.join(' → ')}`)
  }
  const paths = strings(input.scope_paths, 'scope_paths')
  if (paths) task.scope.paths = toPaths(paths)
  const acceptance = strings(input.acceptance, 'acceptance')
  if (acceptance) {
    if (acceptance.length === 0) fail('acceptance を空にはできません')
    task.acceptance = acceptance
  }
  const nonGoals = strings(input.non_goals, 'non_goals')
  if (nonGoals) task.non_goals = nonGoals
  if (typeof input.body === 'string') task.body = input.body.trim()
  if (typeof input.notes === 'string') task.notes = oneLine(input.notes)

  if (task.kind === 'bug' && (severity || input.impacts !== undefined || kind) && task.severity && task.impacts) {
    const fromTable = resolveBugPriority(task.severity, task.impacts, pick(input.impact_priority, PRIORITIES, 'impact_priority'), draft.tasks)
    if (fromTable && fromTable.priority !== task.priority) {
      task.priority = fromTable.priority
      notes.push(fromTable.note)
    }
  }

  if (task.kind === 'bug' && isLate(draft.state.phase) && ordinal(task.priority) >= ordinal('xhigh') && !task.release_blocker) {
    task.release_blocker = true
    notes.push(`${draft.state.phase} で ${task.priority} のバグなので release_blocker を付けた`)
  }

  const status = pick(input.status, ['todo', 'dropped'] as const, 'status')
  if (status && status !== task.status) {
    if (task.status === 'done') fail(`${id} は完了済みです`)
    task.status = status
    delete task.defer
    if (draft.state.active === id) {
      draft.state.active = null
      notes.push('作業中のタスクではなくなった')
    }
  }

  const changed: Record<string, { from: unknown; to: unknown }> = {}
  for (const key of CLASSIFICATION) {
    const a = JSON.stringify(before[key] ?? null)
    const b = JSON.stringify(task[key] ?? null)
    if (a !== b) changed[key] = { from: before[key] ?? null, to: task[key] ?? null }
  }
  if (Object.keys(changed).length > 0) draft.log({ event: 'task.reclassified', actor, taskId: id, changes: changed, reason })
  if (before.status !== task.status) {
    draft.log({ event: 'task.status', actor, taskId: id, from: before.status, to: task.status, reason })
  }
  const otherChanged = ['title', 'acceptance', 'non_goals', 'body', 'notes'].filter(
    key => JSON.stringify(before[key as keyof Task] ?? null) !== JSON.stringify(task[key as keyof Task] ?? null),
  )
  if (otherChanged.length > 0) draft.log({ event: 'task.updated', actor, taskId: id, fields: otherChanged, reason })

  // 後回しのタスクが今のフェーズで着手できる分類になったら戻す（逆は pm_next が後回しにする）
  if (task.status === 'deferred') {
    draft.put(task)
    const eff = effectivePriorities(draft.list()).get(id) ?? ordinal(task.priority)
    if (admits(draft.policy, draft.state.phase, task, eff).ok) {
      task.status = 'todo'
      delete task.defer
      notes.push('今のフェーズで着手できるようになったため todo に戻した')
      draft.log({ event: 'task.restored', taskId: id, phase: draft.state.phase })
    } else {
      task.defer = { until: deferUntil(draft.policy, draft.state.phase, task, eff), reason: task.defer?.reason ?? 'P-FLOOR' }
    }
  }
  draft.put(task)
  return draft.outcome({ task, notes })
}

// ---- pm_complete ----

export type CompleteInput = Readonly<Record<string, unknown>>

export type CompleteResult = { task: Task }

/** タスクを完了にする。作業中でなくても（todo や後回しのタスクも）完了にできる。 */
export const completeTask = (snapshot: Snapshot, input: CompleteInput, now: string, actor = 'main'): Outcome<CompleteResult> => {
  const draft = new Draft(snapshot, now)
  const id = typeof input.taskId === 'string' ? input.taskId.trim() : ''
  const task = draft.tasks.get(id) ?? fail(`タスク ${id || '(taskId なし)'} は存在しません`)
  if (task.status === 'done' || task.status === 'dropped') fail(`${id} は既に ${task.status} です`)
  const notes = typeof input.notes === 'string' ? oneLine(input.notes) : ''
  const from = task.status
  task.status = 'done'
  delete task.defer
  if (notes) task.notes = notes
  if (draft.state.active === id) draft.state.active = null
  draft.put(task)
  draft.log({ event: 'task.completed', actor, taskId: id, from, notes: notes || null })
  return draft.outcome({ task })
}

// ---- フェーズの手動変更 ----

export const setPhase = (snapshot: Snapshot, input: { phase?: unknown; reason?: unknown }, now: string, actor = 'user'): Outcome<{ from: Phase; to: Phase }> => {
  const draft = new Draft(snapshot, now)
  const to = pick(input.phase, PHASES, 'phase') ?? fail('phase は alpha / beta / rc / gm のいずれかです')
  const from = draft.state.phase
  draft.state.phase = to
  draft.log({ event: 'phase.set', actor, from, to, reason: typeof input.reason === 'string' && input.reason !== '' ? input.reason : null })
  return draft.outcome({ from, to })
}
