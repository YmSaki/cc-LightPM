import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { nextTask, effectivePriorities } from '../../src/core/select.ts'
import { addTask } from '../../src/core/ops.ts'
import { priorityAt } from '../../src/core/types.ts'
import type { Task } from '../../src/core/types.ts'
import { NOW, snapshot, task } from './fixtures.ts'

const apply = (tasks: Task[], changed: Task[]): Task[] => {
  const map = new Map(tasks.map(t => [t.id, t]))
  for (const t of changed) map.set(t.id, t)
  return [...map.values()]
}

describe('受け入れ基準', () => {
  test('AC-1: Alpha で max の feature が残っている間、mid の bug は選ばれず P-FLOOR で deferred になる', () => {
    const snap = snapshot([
      task({ id: 'T-0001', kind: 'feature', priority: 'max' }),
      task({ id: 'T-0002', kind: 'bug', priority: 'mid', severity: 'S2', impacts: 'T-0001' }),
    ])
    const out = nextTask(snap, NOW)
    assert.equal(out.result.kind, 'task')
    assert.equal(out.result.kind === 'task' && out.result.task.id, 'T-0001')
    const bug = out.tasks.find(t => t.id === 'T-0002')
    assert.equal(bug?.status, 'deferred')
    assert.deepEqual(bug?.defer, { until: 'beta', reason: 'P-FLOOR' })
    assert.ok(out.events.some(e => e.event === 'task.deferred' && e.taskId === 'T-0002' && e.reason === 'P-FLOOR'))
  })

  test('AC-2: max のタスクに依存されている low の refactor は実効優先度 max で選ばれる', () => {
    const snap = snapshot([
      task({ id: 'T-0001', kind: 'feature', priority: 'max', depends_on: ['T-0003'] }),
      task({ id: 'T-0002', kind: 'feature', priority: 'xhigh' }),
      task({ id: 'T-0003', kind: 'refactor', priority: 'low' }),
    ])
    assert.equal(priorityAt(effectivePriorities(snap.tasks).get('T-0003') ?? 0), 'max')
    const out = nextTask(snap, NOW)
    assert.equal(out.result.kind === 'task' && out.result.task.id, 'T-0003')
    assert.equal(out.result.kind === 'task' && out.result.trace?.top[0]?.eff, 'max')
  })

  test('AC-3: Alpha を抜ける条件を満たすと Beta へ自動で進み phase.advanced を記録する', () => {
    const snap = snapshot([
      task({ id: 'T-0001', kind: 'feature', priority: 'max', status: 'done' }),
      task({ id: 'T-0002', kind: 'bug', priority: 'mid', status: 'deferred', defer: { until: 'beta', reason: 'P-FLOOR' } }),
    ])
    const out = nextTask(snap, NOW)
    assert.equal(out.state.phase, 'beta')
    assert.deepEqual(out.result.kind === 'task' && out.result.phaseAdvanced, [{ from: 'alpha', to: 'beta' }])
    assert.ok(out.events.some(e => e.event === 'phase.advanced' && e.from === 'alpha' && e.to === 'beta'))
  })

  test('AC-4: タスクの読み込み順を 1,000 通り入れ替えても同じ結果を返す', () => {
    const base = [
      task({ id: 'T-0001', kind: 'feature', priority: 'max', depends_on: ['T-0004'] }),
      task({ id: 'T-0002', kind: 'feature', priority: 'max', created: '2026-10-01T00:00:00.000Z' }),
      task({ id: 'T-0003', kind: 'bug', priority: 'xhigh', severity: 'S1', impacts: 'T-0002' }),
      task({ id: 'T-0004', kind: 'chore', priority: 'low' }),
      task({ id: 'T-0005', kind: 'feature', priority: 'high', estimate: 'S' }),
      task({ id: 'T-0006', kind: 'polish', priority: 'low' }),
      task({ id: 'T-0007', kind: 'feature', priority: 'max', estimate: 'S', created: '2026-10-01T00:00:00.000Z' }),
      task({ id: 'T-0008', kind: 'refactor', priority: 'mid', depends_on: ['T-0007'] }),
    ]
    const expected = JSON.stringify(nextTask(snapshot(base), NOW))
    let seed = 42
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let i = 0; i < 1000; i++) {
      const shuffled = [...base]
      for (let j = shuffled.length - 1; j > 0; j--) {
        const k = Math.floor(random() * (j + 1))
        ;[shuffled[j], shuffled[k]] = [shuffled[k] as Task, shuffled[j] as Task]
      }
      assert.equal(JSON.stringify(nextTask(snapshot(shuffled), NOW)), expected)
    }
  })

  test('AC-5: 昇格時に、新しいフェーズで着手できる deferred のタスクが todo に戻る', () => {
    const snap = snapshot([
      task({ id: 'T-0001', kind: 'feature', priority: 'max', status: 'done' }),
      task({ id: 'T-0002', kind: 'bug', priority: 'mid', status: 'deferred', defer: { until: 'beta', reason: 'P-FLOOR' } }),
      task({ id: 'T-0003', kind: 'polish', priority: 'low', status: 'deferred', defer: { until: 'post', reason: 'P-FLOOR' } }),
    ])
    const out = nextTask(snap, NOW)
    assert.equal(out.result.kind === 'task' && out.result.task.id, 'T-0002')
    assert.deepEqual(out.result.kind === 'task' && out.result.restored, ['T-0002'])
    assert.equal(out.tasks.find(t => t.id === 'T-0003'), undefined, '着手できないものは変えない')
  })

  test('AC-6: RC 以降に登録された feature は P-KIND で post になる', () => {
    const out = addTask(
      snapshot([], 'rc'),
      { title: '新機能', kind: 'feature', priority: 'max', scope_paths: ['src/new/**'], acceptance: ['動く'] },
      NOW,
    )
    assert.equal(out.result.task.status, 'deferred')
    assert.deepEqual(out.result.task.defer, { until: 'post', reason: 'P-KIND' })
  })

  test('AC-9: タスク 2,000 件で pm_next が 100 ms 未満で終わる', () => {
    const tasks: Task[] = []
    const kinds = ['feature', 'bug', 'chore', 'refactor', 'polish'] as const
    const priorities = ['max', 'xhigh', 'high', 'mid', 'low', 'xlow'] as const
    for (let i = 1; i <= 2000; i++) {
      const id = `T-${String(i).padStart(4, '0')}`
      const deps = i > 10 && i % 3 === 0 ? [`T-${String(i - 7).padStart(4, '0')}`] : []
      tasks.push(task({ id, kind: kinds[i % 5] as Task['kind'], priority: priorities[i % 6] as Task['priority'], depends_on: deps }))
    }
    const snap = snapshot(tasks)
    nextTask(snap, NOW)
    const started = performance.now()
    const out = nextTask(snap, NOW)
    const elapsed = performance.now() - started
    assert.equal(out.result.kind, 'task')
    assert.ok(elapsed < 100, `${elapsed.toFixed(1)} ms`)
  })
})

describe('選択アルゴリズム', () => {
  test('作業中のタスクがあれば、それを再開する', () => {
    const snap = snapshot([
      task({ id: 'T-0001', kind: 'feature', priority: 'max' }),
      task({ id: 'T-0002', kind: 'feature', priority: 'low', status: 'in_progress' }),
    ])
    snap.state.active = 'T-0002'
    const out = nextTask(snap, NOW)
    assert.equal(out.result.kind === 'task' && out.result.resumed, true)
    assert.equal(out.result.kind === 'task' && out.result.phase, 'alpha')
    assert.equal(out.result.kind === 'task' && out.result.task.id, 'T-0002')
  })

  test('依存が未完了のタスクは候補にならない', () => {
    const snap = snapshot([
      task({ id: 'T-0001', kind: 'feature', priority: 'max', depends_on: ['T-0002'] }),
      task({ id: 'T-0002', kind: 'feature', priority: 'high' }),
    ])
    const out = nextTask(snap, NOW)
    assert.equal(out.result.kind === 'task' && out.result.task.id, 'T-0002')
  })

  test('並べ替え: 妨げている数 → 主役の種別 → 見積 → 作成日時 → id', () => {
    const a = nextTask(
      snapshot([
        task({ id: 'T-0001', kind: 'feature', priority: 'max' }),
        task({ id: 'T-0002', kind: 'feature', priority: 'max' }),
        task({ id: 'T-0003', kind: 'feature', priority: 'max', depends_on: ['T-0002'] }),
      ]),
      NOW,
    )
    assert.equal(a.result.kind === 'task' && a.result.task.id, 'T-0002', '妨げている数が多い方が先')

    const b = nextTask(
      snapshot([
        task({ id: 'T-0001', kind: 'chore', priority: 'max' }),
        task({ id: 'T-0002', kind: 'feature', priority: 'max' }),
      ]),
      NOW,
    )
    assert.equal(b.result.kind === 'task' && b.result.task.id, 'T-0002', 'Alpha の主役は feature')

    const c = nextTask(
      snapshot([
        task({ id: 'T-0001', kind: 'feature', priority: 'max', estimate: 'L' }),
        task({ id: 'T-0002', kind: 'feature', priority: 'max' }),
        task({ id: 'T-0003', kind: 'feature', priority: 'max', estimate: 'S' }),
      ]),
      NOW,
    )
    assert.equal(c.result.kind === 'task' && c.result.task.id, 'T-0003', '見積 S が先、未設定は最後')

    const same = '2026-10-01T00:00:00.000Z'
    const d = nextTask(
      snapshot([
        task({ id: 'T-0002', kind: 'feature', priority: 'max', created: same }),
        task({ id: 'T-0001', kind: 'feature', priority: 'max', created: same }),
      ]),
      NOW,
    )
    assert.equal(d.result.kind === 'task' && d.result.task.id, 'T-0001', '最後は id')
  })

  test('後回しのタスクも、依存されて実効優先度が上がれば todo に戻る', () => {
    const snap = snapshot([
      task({ id: 'T-0001', kind: 'refactor', priority: 'low', status: 'deferred', defer: { until: 'post', reason: 'P-FLOOR' } }),
      task({ id: 'T-0002', kind: 'feature', priority: 'max', depends_on: ['T-0001'] }),
    ])
    const out = nextTask(snap, NOW)
    assert.equal(out.result.kind === 'task' && out.result.task.id, 'T-0001')
  })

  test('抜ける条件を満たさず着手できるものもなければ「待ち」を理由つきで返す', () => {
    const snap = snapshot([
      task({ id: 'T-0001', kind: 'feature', priority: 'max', depends_on: ['T-0002'] }),
      task({ id: 'T-0002', kind: 'release', priority: 'max' }),
    ])
    const out = nextTask(snap, NOW)
    assert.equal(out.result.kind, 'wait')
    assert.match(out.result.kind === 'wait' ? out.result.reasons.join('\n') : '', /T-0001/)
  })

  test('1回の呼び出しで GM まで進み、release タスクがすべて終わっていれば完了', () => {
    const snap = snapshot([
      task({ id: 'T-0001', kind: 'feature', priority: 'max', status: 'done' }),
      task({ id: 'T-0002', kind: 'release', priority: 'mid' }),
    ])
    const out = nextTask(snap, NOW)
    assert.equal(out.state.phase, 'gm')
    assert.equal(out.result.kind === 'task' && out.result.task.id, 'T-0002')
    const done = nextTask({ ...snap, tasks: apply(snap.tasks, [{ ...(snap.tasks[1] as Task), status: 'done' }]) }, NOW)
    assert.equal(done.result.kind, 'done')
  })

  test('タスクが1件もなければフェーズを進めずに待つ', () => {
    const out = nextTask(snapshot([]), NOW)
    assert.equal(out.result.kind, 'wait')
    assert.equal(out.state.phase, 'alpha')
  })

  test('dryRun は状態を変えない', () => {
    const snap = snapshot([task({ id: 'T-0001', kind: 'feature', priority: 'max' })])
    const out = nextTask(snap, NOW, { dryRun: true })
    assert.equal(out.state.active, null)
    assert.equal(out.tasks.length, 0)
  })
})
