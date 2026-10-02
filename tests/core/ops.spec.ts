import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { parseTask, serializeTask } from '../../src/core/frontmatter.ts'
import { InputError, addTask, completeTask, setPhase, updateTask } from '../../src/core/ops.ts'
import { DEFAULT_POLICY, admits, bugPriority, deferUntil, resolvePolicy } from '../../src/core/policy.ts'
import { KINDS, PHASES, PRIORITIES, ordinal } from '../../src/core/types.ts'
import type { Kind, Phase, Priority } from '../../src/core/types.ts'
import { NOW, snapshot, task } from './fixtures.ts'

describe('フェーズポリシー（表駆動）', () => {
  // 仕様書の表：着手できる最低の優先度。null は不可
  const FLOOR: Record<Phase, Record<Kind, Priority | null>> = {
    alpha: { feature: 'high', bug: 'xhigh', chore: 'mid', refactor: 'xhigh', polish: 'xhigh', release: null },
    beta: { feature: 'xhigh', bug: 'mid', chore: 'mid', refactor: 'high', polish: 'high', release: null },
    rc: { feature: null, bug: 'high', chore: 'high', refactor: null, polish: null, release: null },
    gm: { feature: null, bug: null, chore: null, refactor: null, polish: null, release: 'xlow' },
  }
  for (const phase of PHASES) {
    for (const kind of KINDS) {
      for (const priority of PRIORITIES) {
        const floor = FLOOR[phase][kind]
        const expected = floor !== null && ordinal(priority) >= ordinal(floor)
        test(`${phase} ${kind} ${priority} → ${expected ? '可' : '不可'}`, () => {
          const result = admits(DEFAULT_POLICY, phase, task({ id: 'T-0001', kind, priority }), ordinal(priority))
          assert.equal(result.ok, expected)
          if (!result.ok) assert.equal(result.reason, floor === null && !(kind === 'bug' && phase === 'gm') ? 'P-KIND' : 'P-FLOOR')
        })
      }
    }
  }

  test('リリース阻害のバグは RC と GM で優先度に関わらず着手できる', () => {
    const t = task({ id: 'T-0001', kind: 'bug', priority: 'xlow', release_blocker: true })
    assert.equal(admits(DEFAULT_POLICY, 'rc', t, 0).ok, true)
    assert.equal(admits(DEFAULT_POLICY, 'gm', t, 0).ok, true)
  })

  test('defer.until は着手できる最初のフェーズ、どこでも無理なら post', () => {
    assert.equal(deferUntil(DEFAULT_POLICY, 'alpha', task({ id: 'T-0001', kind: 'bug', priority: 'mid' }), ordinal('mid')), 'beta')
    assert.equal(deferUntil(DEFAULT_POLICY, 'alpha', task({ id: 'T-0001', kind: 'polish', priority: 'low' }), ordinal('low')), 'post')
    assert.equal(deferUntil(DEFAULT_POLICY, 'alpha', task({ id: 'T-0001', kind: 'release', priority: 'low' }), ordinal('low')), 'gm')
  })

  test('config.json の policy で上書きできる', () => {
    const policy = resolvePolicy({ alpha: { bug: 'mid', polish: null } })
    assert.deepEqual(policy.alpha.bug, { min: 'mid' })
    assert.deepEqual(policy.alpha.polish, { min: null })
    assert.deepEqual(policy.beta, DEFAULT_POLICY.beta)
  })
})

describe('バグの優先度の表', () => {
  const TABLE: [Priority, string, string, string, string][] = [
    ['max', 'max', 'max', 'xhigh', 'mid'],
    ['xhigh', 'xhigh', 'xhigh', 'high', 'low'],
    ['high', 'xhigh', 'high', 'mid', 'low'],
    ['mid', 'high', 'mid', 'low', 'xlow'],
    ['low', 'high', 'mid', 'low', 'xlow'],
    ['xlow', 'high', 'mid', 'low', 'xlow'],
  ]
  for (const [impact, ...row] of TABLE) {
    test(`影響先 ${impact}`, () => {
      assert.deepEqual(
        (['S0', 'S1', 'S2', 'S3'] as const).map(s => bugPriority(impact, s)),
        row,
      )
    })
  }

  test('pm_add は影響先のタスクから表で優先度を決め、Alpha では後回しにする（付録の例）', () => {
    const snap = snapshot([task({ id: 'T-0009', kind: 'feature', priority: 'high' })])
    const out = addTask(
      snap,
      { title: '空の一覧で CSV を出力すると例外になる', kind: 'bug', severity: 'S2', impacts: 'T-0009', scope_paths: ['src/export/csv.ts'], acceptance: ['例外が出ない'] },
      NOW,
    )
    assert.equal(out.result.task.priority, 'mid')
    assert.equal(out.result.task.status, 'deferred')
    assert.deepEqual(out.result.task.defer, { until: 'beta', reason: 'P-FLOOR' })
    assert.equal(out.result.task.id, 'T-0002')
    assert.equal(out.state.nextId, 3)
  })

  test('RC で max / xhigh のバグには release_blocker が付く', () => {
    const snap = snapshot([task({ id: 'T-0001', kind: 'feature', priority: 'max', status: 'done' })], 'rc')
    const out = addTask(snap, { title: 'クラッシュ', kind: 'bug', severity: 'S0', impacts: 'T-0001', scope_paths: ['src/a.ts'], acceptance: ['落ちない'] }, NOW)
    assert.equal(out.result.task.priority, 'max')
    assert.equal(out.result.task.release_blocker, true)
    assert.equal(out.result.task.status, 'todo')
  })
})

describe('pm_add / pm_update の検証', () => {
  const base = { title: 'x', kind: 'feature', priority: 'max', scope_paths: ['src/x/**'], acceptance: ['ok'] }

  test('必須項目を確かめる（scope_paths は任意）', () => {
    assert.doesNotThrow(() => addTask(snapshot([]), { ...base, scope_paths: undefined }, NOW))
    assert.throws(() => addTask(snapshot([]), { ...base, acceptance: [] }, NOW), InputError)
    assert.throws(() => addTask(snapshot([]), { ...base, title: '' }, NOW), InputError)
    assert.throws(() => addTask(snapshot([]), { ...base, priority: 'urgent' }, NOW), InputError)
    assert.throws(() => addTask(snapshot([]), { ...base, depends_on: ['T-0099'] }, NOW), InputError)
  })

  test('依存の循環は拒否する', () => {
    const snap = snapshot([task({ id: 'T-0001', depends_on: ['T-0002'] }), task({ id: 'T-0002' })])
    assert.throws(() => updateTask(snap, { id: 'T-0002', depends_on: ['T-0001'], reason: 'r' }, NOW), /循環/)
  })

  test('再分類は旧値と新値と理由を監査ログに残す', () => {
    const snap = snapshot([task({ id: 'T-0001', priority: 'mid' })])
    const out = updateTask(snap, { id: 'T-0001', priority: 'max', reason: '基本シナリオに必要だった' }, NOW)
    const event = out.events.find(e => e.event === 'task.reclassified')
    assert.deepEqual(event?.changes, { priority: { from: 'mid', to: 'max' } })
    assert.equal(event?.reason, '基本シナリオに必要だった')
    assert.throws(() => updateTask(snap, { id: 'T-0001', priority: 'max' }, NOW), /reason/)
  })

  test('RC で xhigh 以上に再分類したバグには release_blocker が付く', () => {
    const snap = snapshot([task({ id: 'T-0001', kind: 'bug', priority: 'mid', severity: 'S2', impacts: 'login' })], 'rc')
    const out = updateTask(snap, { id: 'T-0001', priority: 'xhigh', reason: 'データが消えると分かった' }, NOW)
    assert.equal(out.result.task.release_blocker, true)
  })

  test('作業中のタスクを取り下げると active が外れる', () => {
    const snap = snapshot([task({ id: 'T-0001', status: 'in_progress' })])
    snap.state.active = 'T-0001'
    const out = updateTask(snap, { id: 'T-0001', status: 'dropped', reason: '不要になった' }, NOW)
    assert.equal(out.result.task.status, 'dropped')
    assert.equal(out.state.active, null)
  })

  test('フェーズの手動変更は phase.set を記録する', () => {
    const out = setPhase(snapshot([]), { phase: 'beta', reason: 'デモのため' }, NOW)
    assert.equal(out.state.phase, 'beta')
    assert.deepEqual(out.events[0], { event: 'phase.set', actor: 'user', from: 'alpha', to: 'beta', reason: 'デモのため' })
  })
})

describe('pm_complete', () => {
  const active = (): ReturnType<typeof snapshot> => {
    const snap = snapshot([task({ id: 'T-0001', status: 'in_progress', scope: { paths: ['src/export/**'] }, acceptance: ['CSV が出る', '空でも出る'] })])
    snap.state.active = 'T-0001'
    return snap
  }
  const met = [
    { item: 'CSV が出る', met: true },
    { item: '空でも出る', met: true },
  ]

  test('完了条件をすべて満たせば done にして active を外す', () => {
    const out = completeTask(active(), { taskId: 'T-0001', status: 'done', changedFiles: ['src/export/csv.ts', 'src/ui/theme.ts'], acceptance: met }, NOW)
    assert.equal(out.result.kind, 'completed')
    assert.equal(out.result.task.status, 'done')
    assert.equal(out.state.active, null)
    assert.deepEqual(out.events.at(-1)?.files, ['src/export/csv.ts', 'src/ui/theme.ts'])
  })

  test('満たしていない完了条件があれば、まだ完了にしない', () => {
    const out = completeTask(active(), { taskId: 'T-0001', status: 'done', acceptance: [{ item: 'CSV が出る', met: true }] }, NOW)
    assert.equal(out.result.kind, 'incomplete')
    assert.deepEqual(out.result.kind === 'incomplete' && out.result.unmet, ['空でも出る'])
  })

  test('2回続けて失敗したらループを止める', () => {
    const first = completeTask(active(), { taskId: 'T-0001', status: 'failed', notes: 'テストが通らない' }, NOW)
    assert.equal(first.result.kind === 'failed' && first.result.stop, false)
    assert.equal(first.result.task.status, 'todo')
    const again = active()
    again.tasks[0] = { ...(again.tasks[0] as (typeof again.tasks)[number]), failures: 1 }
    const second = completeTask(again, { taskId: 'T-0001', status: 'failed' }, NOW)
    assert.equal(second.result.kind === 'failed' && second.result.stop, true)
  })
})

describe('タスクファイル', () => {
  test('書き出して読み直すと同じになる', () => {
    const t = task({
      id: 'T-0012',
      title: 'CSV エクスポートを実装する: 本体',
      kind: 'bug',
      priority: 'max',
      status: 'deferred',
      depends_on: ['T-0003'],
      scope: { paths: ['src/export/**', 'tests/export/**'] },
      acceptance: ['一覧画面から CSV をダウンロードできる', '"引用" や # を含む'],
      non_goals: ['Excel 形式への対応'],
      estimate: 'M',
      severity: 'S1',
      impacts: 'T-0003',
      release_blocker: true,
      defer: { until: 'beta', reason: 'P-FLOOR' },
      failures: 1,
      notes: 'true',
      body: '主要シナリオの最後のステップ。\n\n- 手順',
    })
    assert.deepEqual(parseTask(serializeTask(t)), t)
  })

  test('scope.paths のないタスクも書き出して読み直せる', () => {
    const t = task({ id: 'T-0002', scope: { paths: [] } })
    assert.doesNotMatch(serializeTask(t), /scope:/)
    assert.deepEqual(parseTask(serializeTask(t)), t)
  })

  test('仕様書の付録の例を読める', () => {
    const text = [
      '---',
      'schema: 1',
      'id: T-0012',
      'title: CSV エクスポートを実装する',
      'kind: feature',
      'priority: max',
      'status: todo',
      'depends_on: [T-0003]',
      'scope:',
      '  paths: ["src/export/**", "tests/export/**"]',
      'acceptance:',
      '  - 一覧画面から CSV をダウンロードできる',
      '  - 空の一覧でも空の CSV が出力される',
      'non_goals:',
      '- Excel 形式への対応',
      'estimate: M',
      'created: 2026-10-02T09:00:00+09:00',
      'updated: 2026-10-02T09:00:00+09:00',
      '---',
      '',
      '主要シナリオ「一覧を見て、保存する」の最後のステップ。',
      '',
    ].join('\n')
    const t = parseTask(text)
    assert.equal(t.id, 'T-0012')
    assert.deepEqual(t.depends_on, ['T-0003'])
    assert.deepEqual(t.scope.paths, ['src/export/**', 'tests/export/**'])
    assert.deepEqual(t.non_goals, ['Excel 形式への対応'])
    assert.equal(t.created, '2026-10-02T09:00:00+09:00')
    assert.equal(t.body, '主要シナリオ「一覧を見て、保存する」の最後のステップ。')
  })

  test('壊れたファイルは理由つきで拒否する', () => {
    assert.throws(() => parseTask('no frontmatter'), /---/)
    assert.throws(() => parseTask('---\nid: T-0001\ntitle: x\nkind: story\npriority: max\nstatus: todo\n---\n'), /kind/)
  })
})
