// 選択アルゴリズム。LLM を呼ばず、.pm/ の状態だけから次の1件を決める。
// 入力のタスクは id 順に並べ直してから扱うため、読み込み順に結果が依存しない。

import { MAIN_KIND, admits, deferUntil, resolvePolicy } from './policy.ts'
import { ESTIMATES, PHASES, isOpen, isResolved, ordinal, priorityAt } from './types.ts'
import type { DeferReason, DeferUntil, LogEvent, Phase, Policy, Priority, Snapshot, State, Task } from './types.ts'

export const byId = (a: Task, b: Task): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** 依存の逆引き：id → その id に依存している未完了タスクの id（id 順）。 */
export const dependentsOf = (tasks: readonly Task[]): Map<string, string[]> => {
  const map = new Map<string, string[]>()
  for (const t of [...tasks].sort(byId)) {
    if (!isOpen(t)) continue
    for (const dep of t.depends_on) {
      const list = map.get(dep) ?? []
      list.push(t.id)
      map.set(dep, list)
    }
  }
  return map
}

/**
 * 実効優先度：eff(T) = max(own(T), max eff(D))。D は T に依存する未完了タスク。
 * 手編集で循環が入っても止まるよう、探索中のものは自分の優先度で打ち切る。
 */
export const effectivePriorities = (tasks: readonly Task[]): Map<string, number> => {
  const byKey = new Map(tasks.map(t => [t.id, t]))
  const dependents = dependentsOf(tasks)
  const memo = new Map<string, number>()
  const visiting = new Set<string>()
  const visit = (id: string): number => {
    const known = memo.get(id)
    if (known !== undefined) return known
    const task = byKey.get(id)
    if (!task) return -1
    if (visiting.has(id)) return ordinal(task.priority)
    visiting.add(id)
    let eff = ordinal(task.priority)
    for (const d of dependents.get(id) ?? []) eff = Math.max(eff, visit(d))
    visiting.delete(id)
    memo.set(id, eff)
    return eff
  }
  for (const t of tasks) visit(t.id)
  return memo
}

/** T が推移的に妨げている未完了タスクの数。 */
export const blockedCount = (id: string, dependents: Map<string, string[]>): number => {
  const seen = new Set<string>()
  const stack = [...(dependents.get(id) ?? [])]
  while (stack.length > 0) {
    const next = stack.pop() as string
    if (seen.has(next) || next === id) continue
    seen.add(next)
    stack.push(...(dependents.get(next) ?? []))
  }
  return seen.size
}

const estimateRank = (t: Task): number => (t.estimate ? ESTIMATES.indexOf(t.estimate) : ESTIMATES.length)

const createdKey = (t: Task): number => {
  const ms = Date.parse(t.created)
  return Number.isNaN(ms) ? Number.MAX_SAFE_INTEGER : ms
}

export type SortKey = { id: string; eff: Priority; blocks: number; main: boolean; estimate: string; created: string }

/** 並べ替え：実効優先度 → 妨げている数 → 主役の種別 → 見積 → 作成日時 → id。 */
export const rank = (eligible: readonly Task[], phase: Phase, eff: Map<string, number>, dependents: Map<string, string[]>): Task[] => {
  const blocks = new Map(eligible.map(t => [t.id, blockedCount(t.id, dependents)]))
  const main = MAIN_KIND[phase]
  return [...eligible].sort((a, b) => {
    const ea = eff.get(a.id) ?? 0
    const eb = eff.get(b.id) ?? 0
    if (ea !== eb) return eb - ea
    const ba = blocks.get(a.id) ?? 0
    const bb = blocks.get(b.id) ?? 0
    if (ba !== bb) return bb - ba
    const ma = a.kind === main ? 0 : 1
    const mb = b.kind === main ? 0 : 1
    if (ma !== mb) return ma - mb
    const sa = estimateRank(a)
    const sb = estimateRank(b)
    if (sa !== sb) return sa - sb
    const ca = createdKey(a)
    const cb = createdKey(b)
    if (ca !== cb) return ca - cb
    return byId(a, b)
  })
}

const sortKey = (t: Task, phase: Phase, eff: Map<string, number>, dependents: Map<string, string[]>): SortKey => ({
  id: t.id,
  eff: priorityAt(eff.get(t.id) ?? 0),
  blocks: blockedCount(t.id, dependents),
  main: t.kind === MAIN_KIND[phase],
  estimate: t.estimate ?? '-',
  created: t.created,
})

// ---- フェーズを抜ける条件 ----

export type ExitCheck = { ok: boolean; condition: string; blocking: Task[] }

const atLeast = (t: Task, p: Priority): boolean => ordinal(t.priority) >= ordinal(p)

export const exitCheck = (phase: Phase, tasks: readonly Task[]): ExitCheck => {
  const open = tasks.filter(t => !isResolved(t))
  const inProgress = open.filter(t => t.status === 'in_progress')
  let condition: string
  let blocking: Task[]
  switch (phase) {
    case 'alpha':
      condition = 'max と xhigh の feature が未完了ゼロ、in_progress ゼロ'
      blocking = open.filter(t => t.kind === 'feature' && atLeast(t, 'xhigh'))
      break
    case 'beta':
      condition = 'xhigh 以上の feature と high 以上の bug が未完了ゼロ、in_progress ゼロ'
      blocking = open.filter(t => (t.kind === 'feature' && atLeast(t, 'xhigh')) || (t.kind === 'bug' && atLeast(t, 'high')))
      break
    case 'rc':
      condition = 'リリース阻害の bug と high 以上の bug が未完了ゼロ、in_progress ゼロ'
      blocking = open.filter(t => t.kind === 'bug' && (t.release_blocker === true || atLeast(t, 'high')))
      break
    case 'gm':
      condition = 'release タスクがすべて完了'
      blocking = open.filter(t => t.kind === 'release')
      break
  }
  const all = [...new Map([...blocking, ...inProgress].map(t => [t.id, t])).values()].sort(byId)
  return { ok: all.length === 0, condition, blocking: all }
}

// ---- pm_next ----

export type Deferral = { id: string; until: DeferUntil; reason: DeferReason }
export type Trace = { phase: Phase; candidates: number; eligible: number; top: SortKey[] }

export type NextResult =
  | {
      kind: 'task'
      phase: Phase
      task: Task
      resumed: boolean
      phaseAdvanced: { from: Phase; to: Phase }[]
      deferred: Deferral[]
      restored: string[]
      trace: Trace | null
    }
  | { kind: 'wait'; phase: Phase; reasons: string[]; phaseAdvanced: { from: Phase; to: Phase }[]; deferred: Deferral[]; restored: string[] }
  | { kind: 'done'; phase: Phase; phaseAdvanced: { from: Phase; to: Phase }[] }

/** 変更されたタスク、新しい状態、監査ログに残す出来事。呼び出し側がまとめて書き込む。 */
export type Outcome<R> = { result: R; tasks: Task[]; state: State; events: LogEvent[] }

/** スナップショットの作業用コピー。変更されたタスクを追跡する。 */
export class Draft {
  readonly tasks: Map<string, Task>
  readonly state: State
  readonly events: LogEvent[] = []
  readonly policy: Policy
  readonly now: string
  private readonly original: Map<string, string>

  constructor(snapshot: Snapshot, now: string) {
    this.now = now
    const sorted = [...snapshot.tasks].sort(byId)
    this.tasks = new Map(sorted.map(t => [t.id, structuredClone(t)]))
    this.original = new Map(sorted.map(t => [t.id, JSON.stringify(t)]))
    this.state = structuredClone(snapshot.state)
    this.policy = resolvePolicy(snapshot.config.policy)
  }

  list(): Task[] {
    return [...this.tasks.values()]
  }

  put(task: Task): void {
    task.updated = this.now
    this.tasks.set(task.id, task)
  }

  log(event: LogEvent): void {
    this.events.push(event)
  }

  outcome<R>(result: R): Outcome<R> {
    const changed = this.list().filter(t => this.original.get(t.id) !== JSON.stringify(t))
    return { result, tasks: changed, state: this.state, events: this.events }
  }
}

const isReady = (t: Task, tasks: Map<string, Task>): boolean =>
  t.depends_on.every(dep => {
    const d = tasks.get(dep)
    return d !== undefined && isResolved(d)
  })

/** 後回しのタスクを今のフェーズで見直し、着手できるものを todo に戻す。 */
const restoreDeferred = (draft: Draft, eff: Map<string, number>): string[] => {
  const restored: string[] = []
  for (const t of draft.list()) {
    if (t.status !== 'deferred') continue
    if (!admits(draft.policy, draft.state.phase, t, eff.get(t.id) ?? ordinal(t.priority)).ok) continue
    t.status = 'todo'
    const from = t.defer
    delete t.defer
    draft.put(t)
    draft.log({ event: 'task.restored', taskId: t.id, phase: draft.state.phase, from: from ?? null })
    restored.push(t.id)
  }
  return restored
}

const waitReasons = (draft: Draft, check: ExitCheck): string[] => {
  const reasons: string[] = [`${draft.state.phase} を抜ける条件（${check.condition}）を満たしていない`]
  for (const t of check.blocking) {
    const missing = t.depends_on.filter(dep => {
      const d = draft.tasks.get(dep)
      return d === undefined || !isResolved(d)
    })
    let why: string
    if (t.status === 'deferred' && t.defer) why = `後回し（${t.defer.reason}、${t.defer.until} まで）`
    else if (missing.length > 0) {
      why = `依存が未完了: ${missing
        .map(dep => {
          const d = draft.tasks.get(dep)
          return d ? `${dep}（${d.status}${d.defer ? ` → ${d.defer.until}` : ''}）` : `${dep}（存在しない）`
        })
        .join(', ')}`
    } else why = t.status
    reasons.push(`${t.id} [${t.priority} ${t.kind}] ${t.title}: ${why}`)
  }
  return reasons
}

/**
 * 次に着手するタスクを1件決める（仕様書「選択アルゴリズム」）。
 * dryRun のときは選んだタスクを in_progress にしない。
 */
export const nextTask = (snapshot: Snapshot, now: string, options: { dryRun?: boolean } = {}): Outcome<NextResult> => {
  const draft = new Draft(snapshot, now)
  const advanced: { from: Phase; to: Phase }[] = []
  const deferred: Deferral[] = []
  const restored: string[] = []

  // 1. 作業中のタスクがあれば、それを返す
  const active = draft.state.active ? draft.tasks.get(draft.state.active) : undefined
  const resumed =
    active && active.status === 'in_progress' ? active : draft.list().find(t => t.status === 'in_progress')
  if (resumed) {
    if (draft.state.active !== resumed.id) draft.state.active = resumed.id
    return draft.outcome({ kind: 'task', phase: draft.state.phase, task: resumed, resumed: true, phaseAdvanced: [], deferred, restored, trace: null })
  }
  if (draft.state.active !== null) {
    draft.state.active = null
    draft.state.baseline = null
  }

  for (;;) {
    const phase = draft.state.phase
    const eff = effectivePriorities(draft.list())
    restored.push(...restoreDeferred(draft, eff))

    // 2. 候補：todo で、依存がすべて完了しているもの
    const candidates = draft.list().filter(t => t.status === 'todo' && isReady(t, draft.tasks))

    // 3. フェーズの下限を満たすものが着手可能。満たさないものは後回し
    const eligible: Task[] = []
    for (const t of candidates) {
      const e = eff.get(t.id) ?? ordinal(t.priority)
      const admission = admits(draft.policy, phase, t, e)
      if (admission.ok) {
        eligible.push(t)
        continue
      }
      const until = deferUntil(draft.policy, phase, t, e)
      t.status = 'deferred'
      t.defer = { until, reason: admission.reason }
      draft.put(t)
      draft.log({ event: 'task.deferred', taskId: t.id, phase, until, reason: admission.reason, eff: priorityAt(e) })
      deferred.push({ id: t.id, until, reason: admission.reason })
    }

    // 4. 着手可能が空なら、抜ける条件を見て昇格するか待つ
    if (eligible.length === 0) {
      const check = exitCheck(phase, draft.list())
      if (phase === 'gm') {
        if (check.ok) return draft.outcome({ kind: 'done', phase, phaseAdvanced: advanced })
        return draft.outcome({ kind: 'wait', phase, reasons: waitReasons(draft, check), phaseAdvanced: advanced, deferred, restored })
      }
      if (!check.ok) {
        return draft.outcome({ kind: 'wait', phase, reasons: waitReasons(draft, check), phaseAdvanced: advanced, deferred, restored })
      }
      const to = PHASES[PHASES.indexOf(phase) + 1] as Phase
      draft.state.phase = to
      draft.log({ event: 'phase.advanced', from: phase, to, condition: check.condition })
      advanced.push({ from: phase, to })
      continue
    }

    // 5. 並べて先頭を選ぶ
    const dependents = dependentsOf(draft.list())
    const ranked = rank(eligible, phase, eff, dependents)
    const chosen = ranked[0] as Task
    const trace: Trace = {
      phase,
      candidates: candidates.length,
      eligible: eligible.length,
      top: ranked.slice(0, 3).map(t => sortKey(t, phase, eff, dependents)),
    }

    // 6. in_progress にして active に設定する
    if (!options.dryRun) {
      chosen.status = 'in_progress'
      draft.put(chosen)
      draft.state.active = chosen.id
      draft.log({ event: 'task.selected', taskId: chosen.id, trace })
    }
    return draft.outcome({ kind: 'task', phase, task: chosen, resumed: false, phaseAdvanced: advanced, deferred, restored, trace })
  }
}
