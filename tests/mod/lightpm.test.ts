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

const COMPOSER = { kind: 'composer' } as const
const pm = (args: string) => ({ command: 'pm', args, origin: COMPOSER, presentation: { isFullscreen: false, columns: 120 } })
const prompt = (text: string) => ({ text, wait: false, origin: COMPOSER })

const MAX_FEATURE = {
  title: 'CSV エクスポートを実装する',
  kind: 'feature',
  priority: 'max',
  scope_paths: ['src/export/**', 'tests/export/**'],
  acceptance: ['一覧画面から CSV をダウンロードできる'],
}

describe('ツール', () => {
  test('pm_add → pm_next → pm_complete の一連の流れ', async ($, on) => {
    const w = world(on)
    expect(text(await $.tool.call({ tool: 'mcp__lightpm__pm_next' } as never))).toContain('まだ使われていません')

    const added = text(await $.tool.call(add(MAX_FEATURE)))
    expect(added).toContain('登録: T-0001 [max feature]')
    expect(w.files.has(`${ROOT}/.pm/state.json`)).toBe(true)
    expect(w.files.get(`${ROOT}/.pm/tasks/T-0001.md`)).toContain('priority: max')

    const bug = text(await $.tool.call(add({ title: '空の一覧で例外', kind: 'bug', severity: 'S2', impacts: 'T-0001', scope_paths: ['src/export/csv.ts'], acceptance: ['例外が出ない'] })))
    expect(bug).toContain('T-0002 [xhigh bug]')

    const next = text(await $.tool.call({ tool: 'mcp__lightpm__pm_next' } as never))
    expect(next).toContain('選択: T-0001')
    expect(next).toContain('タスクの内容（フェーズ Alpha）')
    expect(next).toContain('id: T-0001')
    const state = JSON.parse(w.files.get(`${ROOT}/.pm/state.json`) ?? '{}')
    expect(state.active).toBe('T-0001')

    const done = text(await $.tool.call({ tool: 'mcp__lightpm__pm_complete', taskId: 'T-0001' } as never))
    expect(done).toContain('T-0001 を完了にした')
    expect(w.files.get(`${ROOT}/.pm/tasks/T-0001.md`)).toContain('status: done')

    const log = w.files.get(`${ROOT}/.pm/log/2026-10.jsonl`) ?? ''
    const events = log.trim().split('\n').map(l => JSON.parse(l).event)
    expect(events).toEqual(['task.created', 'task.created', 'task.selected', 'task.completed'])
  })

  test('入力の誤りはエラーとしてモデルに返す', async ($, on) => {
    world(on)
    const out = (await $.tool.call(add({ ...MAX_FEATURE, priority: 'urgent' }))) as { deny?: string }
    expect(out.deny).toContain('priority は xlow / low / mid / high / xhigh / max のいずれかです')
  })

  test('並行した pm_add でも id が重複しない', async ($, on) => {
    const w = world(on)
    await Promise.all([1, 2, 3, 4].map(i => $.tool.call(add({ ...MAX_FEATURE, title: `機能 ${i}` }))))
    const ids = [...w.files.keys()].filter(k => k.includes('/tasks/T-')).sort()
    expect(ids.length).toBe(4)
    expect(JSON.parse(w.files.get(`${ROOT}/.pm/state.json`) ?? '{}').nextId).toBe(5)
  })

  test('AC-10: .pm/ の外へは書き込まない', async ($, on) => {
    const w = world(on)
    await $.tool.call(add(MAX_FEATURE))
    await $.tool.call({ tool: 'mcp__lightpm__pm_next' } as never)
    await $.tool.call({ tool: 'mcp__lightpm__pm_update', id: 'T-0001', priority: 'xhigh', reason: 'テスト' } as never)
    await $.tool.call({ tool: 'mcp__lightpm__pm_complete', taskId: 'T-0001', notes: 'x' } as never)
    await $.tool.call({ tool: 'mcp__lightpm__pm_status' } as never)
    await $.command.run(pm('phase set beta テスト'))
    expect(w.writes.length > 0).toBe(true)
    expect(w.writes.filter(p => !p.startsWith(`${ROOT}/.pm/`))).toEqual([])
  })
})

describe('/pm', () => {
  test('init と status', async ($, on) => {
    world(on)
    expect((await $.command.run(pm('init'))).text).toContain('.pm/ を作りました')
    await $.tool.call(add(MAX_FEATURE))
    const status = (await $.command.run(pm(''))).text ?? ''
    expect(status).toContain('フェーズ Alpha')
    expect(status).toContain('次の候補: T-0001')
    const why = (await $.command.run(pm('why T-0001'))).text ?? ''
    expect(why).toContain('登録: feature / max')
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
    expect(tools).toEqual(['pm_status', 'pm_next', 'pm_add', 'pm_update', 'pm_complete'])
    expect(commands).toEqual(['pm'])
  })

  test('プロンプトにフェーズと作業中のタスクの要約を足す（600 文字以内）', async ($, on) => {
    world(on)
    let context: readonly string[] = []
    on('prompt.submit', ($, e) => {
      context = e.context ?? []
      return { text: e.text }
    })
    await $.prompt.submit(prompt('hello'))
    expect(context).toEqual([])

    await $.tool.call(add(MAX_FEATURE))
    await $.tool.call({ tool: 'mcp__lightpm__pm_next' } as never)
    await $.prompt.submit(prompt('hello'))
    expect(context.length).toBe(1)
    expect(context[0]).toContain('今やること: T-0001「CSV エクスポートを実装する」')
    expect((context[0] ?? '').length <= 600).toBe(true)
  })

  test('帯にフェーズと作業中のタスクと残数を1行で出す', async ($, on) => {
    world(on)
    await $.tool.call(add(MAX_FEATURE))
    await $.tool.call({ tool: 'mcp__lightpm__pm_next' } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      const line = await ui.find({ type: 'Text', text: /LightPM/ })
      expect(line?.text).toBe('LightPM Alpha · ▶ T-0001 CSV エクスポートを実装する [max] · todo 0 · 後回し 0 · 完了 0')
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

  test('優先順に並び、選ぶと「やること」を展開・折りたたみできる', async ($, on) => {
    world(on)
    await $.tool.call(add({ ...MAX_FEATURE, acceptance: ['CSV をダウンロードできる', '空の一覧でも出力できる'] }))
    await $.tool.call(add({ title: '設定画面', kind: 'feature', priority: 'high', acceptance: ['保存できる'] }))
    await $.tool.call(add({ title: 'ボタンの色', kind: 'polish', priority: 'low', acceptance: ['色が揃う'] }))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const labels = (await ui.findAll({ type: 'Button' })).map(b => b.text)
      expect(labels).toEqual(['▸ 1. T-0001 [max] CSV エクスポートを実装する', '▸ 2. T-0002 [high] 設定画面', '▸ T-0003 [low] ボタンの色'])
      expect((await ui.find({ type: 'Text', text: '後回し（1）' }))?.text).toBe('後回し（1）')
      expect(await ui.find({ type: 'Text', text: '2. 空の一覧でも出力できる' })).toBeUndefined()

      await ui.press({ key: 't:T-0001' })
      expect((await ui.find({ key: 't:T-0001' }))?.text).toBe('▾ 1. T-0001 [max] CSV エクスポートを実装する')
      expect((await ui.find({ type: 'Text', text: '2. 空の一覧でも出力できる' }))?.text).toBe('2. 空の一覧でも出力できる')

      await ui.press({ key: 't:T-0001' })
      expect(await ui.find({ type: 'Text', text: '2. 空の一覧でも出力できる' })).toBeUndefined()
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
