import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { boardRows, contextFor, formatList, formatShow, summarize } from '../../src/core/format.ts'
import { parseTask, serializeTask } from '../../src/core/frontmatter.ts'
import { InputError, addTask, updateTask } from '../../src/core/ops.ts'
import { bugPriority, sortTasks } from '../../src/core/priority.ts'
import type { Priority, Task } from '../../src/core/types.ts'
import { NOW, snapshot, task } from './fixtures.ts'

const items = (...texts: string[]) => texts.map(text => ({ text, done: false }))

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

  test('pm_add は影響先のタスクから表で優先度を決める', () => {
    const snap = snapshot([task({ id: 'T-0009', kind: 'feature', priority: 'high' })])
    const out = addTask(snap, { title: '空の一覧で例外', kind: 'bug', severity: 'S2', impacts: 'T-0009', checklist: ['例外が出ない'] }, NOW)
    assert.equal(out.result.task.priority, 'mid')
    assert.equal(out.result.task.status, 'todo')
    assert.equal(out.result.task.id, 'T-0002')
    assert.equal(out.state.nextId, 3)
  })

  test('影響先がタスクでなければ impact_priority を使う', () => {
    const out = addTask(snapshot([]), { title: 'ログインで落ちる', kind: 'bug', severity: 'S0', impacts: 'ログイン', impact_priority: 'max', checklist: ['落ちない'] }, NOW)
    assert.equal(out.result.task.priority, 'max')
  })
})

describe('pm_add', () => {
  const base = { title: 'x', kind: 'feature', priority: 'max', checklist: ['ok'] }

  test('登録した内容と変更履歴', () => {
    const out = addTask(snapshot([]), { ...base, body: '説明', checklist: ['a', 'b'], reason: '基本機能' }, NOW)
    assert.deepEqual(out.result.task.checklist, items('a', 'b'))
    assert.equal(out.result.task.body, '説明')
    assert.deepEqual(out.events, [{ event: 'task.created', actor: 'main', taskId: 'T-0001', kind: 'feature', priority: 'max', reason: '基本機能' }])
  })

  test('必須項目を確かめる', () => {
    assert.throws(() => addTask(snapshot([]), { ...base, checklist: [] }, NOW), InputError)
    assert.throws(() => addTask(snapshot([]), { ...base, title: '' }, NOW), InputError)
    assert.throws(() => addTask(snapshot([]), { ...base, priority: 'urgent' }, NOW), InputError)
    assert.throws(() => addTask(snapshot([]), { ...base, depends_on: ['T-0099'] }, NOW), InputError)
    assert.throws(() => addTask(snapshot([]), { ...base, kind: 'bug' }, NOW), /severity/)
  })
})

describe('pm_update', () => {
  const three = (): ReturnType<typeof snapshot> => snapshot([task({ id: 'T-0001', checklist: items('a', 'b', 'c') })])

  test('項目を済みにすると作業中になり、全部済むと完了になる', () => {
    const first = updateTask(three(), { id: 'T-0001', check: [1] }, NOW)
    assert.equal(first.result.task.status, 'in_progress')
    assert.deepEqual(first.result.task.checklist.map(i => i.done), [true, false, false])
    assert.deepEqual(
      first.events.map(e => e.event),
      ['task.progress', 'task.status'],
    )

    const all = updateTask(three(), { id: 'T-0001', check: [1, 2, 3] }, NOW)
    assert.equal(all.result.task.status, 'done')
  })

  test('済みを戻すと完了から作業中に戻る。status を指定すればそれを使う', () => {
    const done = snapshot([task({ id: 'T-0001', status: 'done', checklist: [{ text: 'a', done: true }, { text: 'b', done: true }] })])
    assert.equal(updateTask(done, { id: 'T-0001', uncheck: [2] }, NOW).result.task.status, 'in_progress')
    assert.equal(updateTask(three(), { id: 'T-0001', check: [1, 2, 3], status: 'in_progress' }, NOW).result.task.status, 'in_progress')
    assert.equal(updateTask(three(), { id: 'T-0001', status: 'dropped' }, NOW).result.task.status, 'dropped')
  })

  test('存在しない項目番号は拒否する', () => {
    assert.throws(() => updateTask(three(), { id: 'T-0001', check: [4] }, NOW), /4 番目/)
  })

  test('チェックリストを置き換えても、同じ文面の項目は済みの印を引き継ぐ', () => {
    const snap = snapshot([task({ id: 'T-0001', checklist: [{ text: 'a', done: true }, { text: 'b', done: false }] })])
    const out = updateTask(snap, { id: 'T-0001', checklist: ['a', 'c'] }, NOW)
    assert.deepEqual(out.result.task.checklist, [{ text: 'a', done: true }, { text: 'c', done: false }])
  })

  test('種別や優先度の変更は理由が必須で、旧値と新値と理由を残す', () => {
    const snap = snapshot([task({ id: 'T-0001', priority: 'mid' })])
    assert.throws(() => updateTask(snap, { id: 'T-0001', priority: 'max' }, NOW), /reason/)
    const out = updateTask(snap, { id: 'T-0001', priority: 'max', reason: '基本シナリオに必要だった' }, NOW)
    const event = out.events.find(e => e.event === 'task.reclassified')
    assert.deepEqual(event?.changes, { priority: { from: 'mid', to: 'max' } })
    assert.equal(event?.reason, '基本シナリオに必要だった')
  })

  test('依存の循環は拒否する', () => {
    const snap = snapshot([task({ id: 'T-0001', depends_on: ['T-0002'] }), task({ id: 'T-0002' })])
    assert.throws(() => updateTask(snap, { id: 'T-0002', depends_on: ['T-0001'] }, NOW), /循環/)
  })
})

describe('一覧', () => {
  test('優先度の高い順 → 作成日時 → id。読み込み順に関係なく同じ順になる', () => {
    const base = [
      task({ id: 'T-0001', priority: 'low' }),
      task({ id: 'T-0002', priority: 'max', created: '2026-10-01T00:00:00.000Z' }),
      task({ id: 'T-0003', priority: 'max', created: '2026-10-01T00:00:00.000Z' }),
      task({ id: 'T-0004', priority: 'max', created: '2026-09-30T00:00:00.000Z' }),
      task({ id: 'T-0005', priority: 'xhigh' }),
    ]
    const expected = ['T-0004', 'T-0002', 'T-0003', 'T-0005', 'T-0001']
    assert.deepEqual(sortTasks(base).map(t => t.id), expected)
    assert.deepEqual(sortTasks([...base].reverse()).map(t => t.id), expected)
  })

  test('状態ごとにまとめ、進捗と前提を明示する', () => {
    const tasks = [
      task({ id: 'T-0001', priority: 'max', status: 'done' }),
      task({ id: 'T-0002', title: '保存', priority: 'max', depends_on: ['T-0001'], checklist: [{ text: 'a', done: true }, { text: 'b', done: false }], status: 'in_progress' }),
      task({ id: 'T-0003', title: '一覧', priority: 'high', depends_on: ['T-0002'] }),
      task({ id: 'T-0004', priority: 'low', status: 'dropped' }),
    ]
    assert.equal(
      formatList(tasks),
      [
        '作業中（1）',
        '- T-0002 [max feature] 保存  1/2  前提: T-0001（完了）',
        '',
        '未着手（1）',
        '- T-0003 [high feature] 一覧  0/1  前提: T-0002（作業中）',
        '',
        '完了 1 件（/pm list done で表示）',
      ].join('\n'),
    )
    assert.deepEqual(
      boardRows(tasks).map(r => [r.id, r.group]),
      [
        ['T-0002', 'active'],
        ['T-0003', 'todo'],
        ['T-0001', 'done'],
      ],
    )
  })

  test('タスクの内容にチェックリストを出す', () => {
    const t = task({ id: 'T-0002', title: '保存', body: 'JSON に保存する', checklist: [{ text: 'a', done: true }, { text: 'b', done: false }], status: 'in_progress' })
    assert.equal(formatShow(t, [t]), ['T-0002 [mid feature] 保存（作業中、1/2）', '', 'JSON に保存する', '', 'やること:', '[x] 1. a', '[ ] 2. b'].join('\n'))
  })

  test('プロンプトに足す文脈は600文字以内', () => {
    const long = task({ id: 'T-0001', title: 'あ'.repeat(800), status: 'in_progress' })
    const text = contextFor(summarize([long], 0))
    assert.ok(text.length <= 600)
    assert.ok(text.endsWith('…'))
    assert.match(contextFor(summarize([task({ id: 'T-0002', priority: 'max' })], 0)), /最優先の未着手は T-0002/)
  })
})

describe('タスクファイル', () => {
  test('書き出して読み直すと同じになる', () => {
    const t: Task = task({
      id: 'T-0012',
      title: 'CSV エクスポートを実装する: 本体',
      kind: 'bug',
      priority: 'max',
      status: 'in_progress',
      depends_on: ['T-0003'],
      checklist: [{ text: '一覧画面から CSV をダウンロードできる', done: true }, { text: '"引用" や # を含む', done: false }],
      severity: 'S1',
      impacts: 'T-0003',
      notes: 'true',
      body: '主要シナリオの最後のステップ。\n\n- 手順',
    })
    const text = serializeTask(t)
    assert.match(text, /- "\[x\] 一覧画面から CSV をダウンロードできる"/)
    assert.deepEqual(parseTask(text), t)
  })

  test('引用符のない "- [x] 項目" も読める', () => {
    const t = parseTask(['---', 'id: T-0001', 'title: x', 'kind: feature', 'priority: max', 'status: todo', 'checklist:', '  - [x] できた', '  - [ ] まだ', '---', ''].join('\n'))
    assert.deepEqual(t.checklist, [{ text: 'できた', done: true }, { text: 'まだ', done: false }])
  })

  test('以前の形式（acceptance、deferred）も読める', () => {
    const t = parseTask(['---', 'id: T-0001', 'title: x', 'kind: feature', 'priority: low', 'status: deferred', 'acceptance:', '  - 動く', 'defer:', '  until: beta', '  reason: P-FLOOR', '---', ''].join('\n'))
    assert.equal(t.status, 'todo')
    assert.deepEqual(t.checklist, items('動く'))
  })

  test('壊れたファイルは理由つきで拒否する', () => {
    assert.throws(() => parseTask('no frontmatter'), /---/)
    assert.throws(() => parseTask('---\nid: T-0001\ntitle: x\nkind: story\npriority: max\nstatus: todo\n---\n'), /kind/)
  })
})
