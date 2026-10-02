// モッドのテスト（claude plugin test）。$.fs をメモリ上の Map で置き換えて動かす。

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = '/repo'

type World = {
  files: Map<string, string>
  writes: string[]
}

const world = (on: On, seed: Record<string, string> = {}): World => {
  const files = new Map(Object.entries(seed).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const w: World = { files, writes: [] }
  const isDir = (path: string): boolean => [...files.keys()].some(k => k.startsWith(`${path.replace(/\/$/, '')}/`))
  mock.clock(on, { now: Date.parse('2026-10-02T09:00:00.000Z') })
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => {
    w.writes.push(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const dir = `${e.path.replace(/\/$/, '')}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const key of files.keys()) {
      if (!key.startsWith(dir)) continue
      const rest = key.slice(dir.length)
      const [head, ...tail] = rest.split('/')
      if (head) names.set(head, tail.length > 0 ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  return w
}

const text = (r: unknown): string => {
  const o = r as { result?: unknown; deny?: string }
  return o.deny ?? String(o.result)
}

const add = (fields: Record<string, unknown>) => ({ tool: 'mcp__lightpm__pm_add', ...fields }) as never
const upd = (fields: Record<string, unknown>) => ({ tool: 'mcp__lightpm__pm_update', ...fields }) as never
const call = (tool: string, fields: Record<string, unknown> = {}) => ({ tool: `mcp__lightpm__${tool}`, ...fields }) as never

const COMPOSER = { kind: 'composer' } as const
const pm = (args: string) => ({ command: 'pm', args, origin: COMPOSER, presentation: { isFullscreen: false, columns: 120 } })
const prompt = (text: string) => ({ text, wait: false, origin: COMPOSER })

const MAX_FEATURE = {
  title: 'CSV エクスポートを実装する',
  kind: 'feature',
  priority: 'max',
  body: '一覧画面に CSV で保存するボタンを付ける',
  checklist: ['ボタンを付ける', 'CSV を組み立てる', '空の一覧でも出力できる'],
}

describe('ツール', () => {
  test('登録 → 一覧 → 内容 → 進捗の更新 → 完了', async ($, on) => {
    const w = world(on)
    expect(text(await $.tool.call(call('pm_list')))).toContain('まだ使われていません')

    expect(text(await $.tool.call(add(MAX_FEATURE)))).toBe('登録: T-0001 [max feature] CSV エクスポートを実装する — 未着手 0/3')
    expect(w.files.has(`${ROOT}/.pm/state.json`)).toBe(true)
    expect(w.files.get(`${ROOT}/.pm/tasks/T-0001.md`)).toContain('- "[ ] ボタンを付ける"')

    const bug = text(await $.tool.call(add({ title: '空の一覧で例外', kind: 'bug', severity: 'S2', impacts: 'T-0001', checklist: ['例外が出ない'] })))
    expect(bug).toContain('T-0002 [xhigh bug]')

    expect(text(await $.tool.call(call('pm_list')))).toBe(
      ['未着手（2）', '- T-0001 [max feature] CSV エクスポートを実装する  0/3', '- T-0002 [xhigh bug] 空の一覧で例外  0/1'].join('\n'),
    )
    expect(text(await $.tool.call(call('pm_show', { id: 'T-0001' })))).toContain('[ ] 2. CSV を組み立てる')

    expect(text(await $.tool.call(upd({ id: 'T-0001', check: [1] })))).toBe('更新: T-0001 [max feature] CSV エクスポートを実装する — 作業中 1/3')
    expect(text(await $.tool.call(upd({ id: 'T-0001', check: [2, 3] })))).toBe('更新: T-0001 [max feature] CSV エクスポートを実装する — 完了 3/3')
    expect(w.files.get(`${ROOT}/.pm/tasks/T-0001.md`)).toContain('status: done')

    // 完了済みのタスクで済みを戻すと、作業中に戻る
    expect(text(await $.tool.call(upd({ id: 'T-0001', uncheck: [1, 2, 3] })))).toBe('更新: T-0001 [max feature] CSV エクスポートを実装する — 作業中 0/3')
    expect(w.files.get(`${ROOT}/.pm/tasks/T-0001.md`)).toContain('status: in_progress')
    expect(w.files.get(`${ROOT}/.pm/tasks/T-0001.md`)).toContain('- "[ ] ボタンを付ける"')

    const log = w.files.get(`${ROOT}/.pm/log/2026-10.jsonl`) ?? ''
    const events = log.trim().split('\n').map(l => JSON.parse(l).event)
    expect(events).toEqual(['task.created', 'task.created', 'task.progress', 'task.status', 'task.progress', 'task.status', 'task.progress', 'task.status'])
  })

  test('入力の誤りはエラーとしてモデルに返す', async ($, on) => {
    world(on)
    const out = (await $.tool.call(add({ ...MAX_FEATURE, priority: 'urgent' }))) as { deny?: string }
    expect(out.deny).toContain('priority は xlow / low / mid / high / xhigh / max のいずれかです')
    await $.tool.call(add(MAX_FEATURE))
    const noReason = (await $.tool.call(upd({ id: 'T-0001', priority: 'low' }))) as { deny?: string }
    expect(noReason.deny).toContain('reason')
  })

  test('並行した pm_add でも id が重複しない', async ($, on) => {
    const w = world(on)
    await Promise.all([1, 2, 3, 4].map(i => $.tool.call(add({ ...MAX_FEATURE, title: `機能 ${i}` }))))
    const ids = [...w.files.keys()].filter(k => k.includes('/tasks/T-')).sort()
    expect(ids.length).toBe(4)
    expect(JSON.parse(w.files.get(`${ROOT}/.pm/state.json`) ?? '{}').nextId).toBe(5)
  })

  test('.pm/ の外へは書き込まない', async ($, on) => {
    const w = world(on)
    await $.tool.call(add(MAX_FEATURE))
    await $.tool.call(upd({ id: 'T-0001', check: [1], priority: 'xhigh', reason: 'テスト' }))
    await $.tool.call(call('pm_list', { status: 'all' }))
    await $.tool.call(call('pm_show', { id: 'T-0001' }))
    await $.command.run(pm(''))
    expect(w.writes.length > 0).toBe(true)
    expect(w.writes.filter(p => !p.startsWith(`${ROOT}/.pm/`))).toEqual([])
  })
})

describe('/pm', () => {
  test('init、一覧、内容、変更履歴', async ($, on) => {
    world(on)
    expect((await $.command.run(pm('init'))).text).toContain('.pm/ を作りました')
    await $.tool.call(add({ ...MAX_FEATURE, reason: '基本シナリオの最後の段階' }))
    await $.tool.call(upd({ id: 'T-0001', priority: 'xhigh', reason: '先に保存を作る' }))
    expect((await $.command.run(pm(''))).text).toContain('- T-0001 [xhigh feature] CSV エクスポートを実装する  0/3')
    expect((await $.command.run(pm('show T-0001'))).text).toContain('一覧画面に CSV で保存するボタンを付ける')
    const why = (await $.command.run(pm('why T-0001'))).text ?? ''
    expect(why).toContain('登録: feature / max — 基本シナリオの最後の段階')
    expect(why).toContain('分類の変更: priority max → xhigh — 先に保存を作る')
  })
})

describe('セッション・プロンプト・帯', () => {
  const BAND = {
    plugin: 'lightpm',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  } as const

  test('session.start でツールと /pm を登録する', async ($, on) => {
    world(on)
    const tools: string[] = []
    const commands: string[] = []
    on('tool.register', ($, e) => {
      tools.push(e.name)
      return { value: { tool: `mcp__lightpm__${e.name}` } }
    })
    on('command.register', ($, e) => {
      commands.push(e.name)
      return { value: { command: e.name } }
    })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    expect(tools).toEqual(['pm_list', 'pm_show', 'pm_add', 'pm_update'])
    expect(commands).toEqual(['pm'])
  })

  test('プロンプトに作業中のタスクと進捗を足す（600 文字以内）', async ($, on) => {
    world(on)
    let context: readonly string[] = []
    on('prompt.submit', ($, e) => {
      context = e.context ?? []
      return { text: e.text }
    })
    await $.prompt.submit(prompt('hello'))
    expect(context).toEqual([])

    await $.tool.call(add(MAX_FEATURE))
    await $.prompt.submit(prompt('hello'))
    expect(context[0]).toContain('最優先の未着手は T-0001「CSV エクスポートを実装する」（max）')

    await $.tool.call(upd({ id: 'T-0001', check: [1] }))
    await $.prompt.submit(prompt('hello'))
    expect(context[0]).toContain('作業中: T-0001「CSV エクスポートを実装する」（max、1/3）')
    expect((context[0] ?? '').length <= 600).toBe(true)
  })

  test('帯に作業中のタスクと進捗、残数を1行で出す', async ($, on) => {
    world(on)
    await $.tool.call(add(MAX_FEATURE))
    await $.tool.call(upd({ id: 'T-0001', check: [1] }))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      const line = await ui.find({ type: 'Text', text: /LightPM/ })
      expect(line?.text).toBe('LightPM · ▶ T-0001 CSV エクスポートを実装する [max] 1/3 · 作業中 1 · 未着手 0 · 完了 0')
      await ui.unmount()
    }
  })
})

describe('タスク一覧のペイン', () => {
  const PANE = {
    plugin: 'lightpm',
    component: 'Pane',
    requestId: 'lightpm-tasks',
    props: { title: 'LightPM タスク', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as const

  test('優先度順に並び、選ぶと説明とやることを展開する。完了は畳んでおける', async ($, on) => {
    world(on)
    await $.tool.call(add({ title: 'ボタンの色', kind: 'polish', priority: 'low', checklist: ['色が揃う'] }))
    await $.tool.call(add(MAX_FEATURE))
    await $.tool.call(add({ title: '設定画面', kind: 'feature', priority: 'high', checklist: ['保存できる'], depends_on: ['T-0002'] }))
    await $.tool.call(upd({ id: 'T-0002', check: [1] }))
    await $.tool.call(upd({ id: 'T-0001', check: [1] }))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const labels = (await ui.findAll({ type: 'Button' })).map(b => b.text)
      expect(labels).toEqual(['▸ T-0002 [max] CSV エクスポートを実装する  1/3', '▸ T-0003 [high] 設定画面  0/1', '▸ 完了（1）'])
      expect(await ui.find({ type: 'Text', text: '[x] 1. ボタンを付ける' })).toBeUndefined()

      await ui.press({ key: 't:T-0002' })
      expect((await ui.find({ type: 'Text', text: '[x] 1. ボタンを付ける' }))?.text).toBe('[x] 1. ボタンを付ける')
      expect((await ui.find({ type: 'Text', text: '一覧画面に CSV で保存する' }))?.text).toBe('一覧画面に CSV で保存するボタンを付ける')
      await ui.press({ key: 't:T-0002' })

      await ui.press({ key: 't:T-0003' })
      expect((await ui.find({ type: 'Text', text: /前提: T-0002（作業中）/ }))?.text).toBe('種別 feature  前提: T-0002（作業中）')
      await ui.press({ key: 't:T-0003' })

      await ui.press({ key: 'toggle-done' })
      expect((await ui.find({ key: 't:T-0001' }))?.text).toBe('▸ T-0001 [low] ボタンの色  1/1')
      await ui.press({ key: 'toggle-done' })
      await ui.unmount()
    }
  })

  test('/pm view でペインを開き、帯の「一覧」ボタンからも開ける', async ($, on) => {
    world(on)
    const opened: string[] = []
    on('ui.open', ($, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    await $.command.run(pm('init'))
    expect((await $.command.run(pm('view'))).text).toContain('タスク一覧を開きました')
    const band = await $.ui.mount({
      plugin: 'lightpm',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    await band.press({ key: 'board' })
    expect(opened).toEqual(['lightpm-tasks', 'lightpm-tasks'])
  })
})
