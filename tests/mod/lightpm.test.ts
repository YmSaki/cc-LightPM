// モッドのテスト（claude plugin test）。$.fs と git をメモリ上の Map で置き換えて動かす。

import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = '/repo'

type World = {
  files: Map<string, string>
  writes: string[]
  git: { changed: string[]; untracked: string[] }
}

const world = (on: On, seed: Record<string, string> = {}): World => {
  const files = new Map(Object.entries(seed).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const w: World = { files, writes: [], git: { changed: [], untracked: [] } }
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
  on('process.run', ($, e) => {
    const args = e.argv.slice(3).join(' ')
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (args.startsWith('rev-parse --is-inside-work-tree')) return ok('true\n')
    if (args.startsWith('stash create')) return ok('')
    if (args.startsWith('rev-parse HEAD')) return ok('abc123\n')
    if (args.startsWith('ls-files')) return ok(w.git.untracked.map(f => `${f}\0`).join(''))
    if (args.startsWith('diff')) return ok(w.git.changed.map(f => `${f}\0`).join(''))
    return { value: { exitCode: 1, stdout: '', stderr: 'unknown', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'edited' }))
  on('tool.call', { tool: 'Write' }, () => ({ result: 'written' }))
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
    expect(next).toContain('タスク契約 T-0001')
    const state = JSON.parse(w.files.get(`${ROOT}/.pm/state.json`) ?? '{}')
    expect(state.active).toBe('T-0001')
    expect(state.baseline).toEqual({ ref: 'abc123', untracked: [] })

    w.git.changed = ['src/export/csv.ts']
    w.git.untracked = ['tests/export/csv.test.ts']
    const done = text(
      await $.tool.call({
        tool: 'mcp__lightpm__pm_complete',
        taskId: 'T-0001',
        status: 'done',
        changedFiles: ['src/export/csv.ts'],
        acceptance: [{ item: '一覧画面から CSV をダウンロードできる', met: true }],
      } as never),
    )
    expect(done).toContain('T-0001 を完了にした')
    expect(done).toContain('git diff')
    expect(w.files.get(`${ROOT}/.pm/tasks/T-0001.md`)).toContain('status: done')

    const log = w.files.get(`${ROOT}/.pm/log/2026-10.jsonl`) ?? ''
    const events = log.trim().split('\n').map(l => JSON.parse(l).event)
    expect(events).toEqual(['task.created', 'task.created', 'task.selected', 'task.completed'])
  })

  test('AC-8: 範囲外の変更があれば完了にしない', async ($, on) => {
    const w = world(on)
    await $.tool.call(add(MAX_FEATURE))
    await $.tool.call({ tool: 'mcp__lightpm__pm_next' } as never)
    w.git.changed = ['src/export/csv.ts', 'src/ui/theme.ts']
    const out = text(
      await $.tool.call({
        tool: 'mcp__lightpm__pm_complete',
        taskId: 'T-0001',
        status: 'done',
        acceptance: [{ item: '一覧画面から CSV をダウンロードできる', met: true }],
      } as never),
    )
    expect(out).toContain('完了にしていない')
    expect(out).toContain('src/ui/theme.ts')
    expect(w.files.get(`${ROOT}/.pm/tasks/T-0001.md`)).toContain('status: in_progress')
    expect(w.files.get(`${ROOT}/.pm/log/2026-10.jsonl`)).toContain('"event":"scope.violation"')
  })

  test('入力の誤りはエラーとしてモデルに返す', async ($, on) => {
    world(on)
    const out = (await $.tool.call(add({ ...MAX_FEATURE, scope_paths: ['**'] }))) as { deny?: string }
    expect(out.deny).toContain('広すぎます')
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
    await $.tool.call({ tool: 'mcp__lightpm__pm_complete', taskId: 'T-0001', status: 'failed', notes: 'x' } as never)
    await $.tool.call({ tool: 'mcp__lightpm__pm_status' } as never)
    await $.command.run(pm('phase set beta テスト'))
    await $.command.run(pm('enforce block'))
    expect(w.writes.length > 0).toBe(true)
    expect(w.writes.filter(p => !p.startsWith(`${ROOT}/.pm/`))).toEqual([])
  })
})

describe('ガード', () => {
  test('AC-7: block では範囲外の編集を拒否し、範囲内は通す', async ($, on) => {
    world(on, { '.pm/config.json': JSON.stringify({ schema: 1, enforcement: 'block', scopeVerify: true, policy: {} }) })
    await $.tool.call(add(MAX_FEATURE))
    await $.tool.call({ tool: 'mcp__lightpm__pm_next' } as never)
    const outside = (await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/ui/theme.ts`, old_string: 'a', new_string: 'b' } as never)) as { deny?: string }
    expect(outside.deny).toBe(
      'LightPM: T-0001 の範囲外です（src/ui/theme.ts）。直さずに mcp__lightpm__pm_add で登録し、T-0001 の作業を続けてください。範囲: src/export/**, tests/export/**',
    )
    const inside = (await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/export/csv.ts`, old_string: 'a', new_string: 'b' } as never)) as { deny?: string; result?: unknown }
    expect(inside.deny).toBeUndefined()
    expect(inside.result).toBe('edited')
  })

  test('warn（既定）は編集を通し、モデルへの注意と監査ログを残す', async ($, on) => {
    const w = world(on)
    await $.tool.call(add(MAX_FEATURE))
    const ran = (await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/other.ts`, content: 'x' } as never)) as { deny?: string; context?: string[] }
    expect(ran.deny).toBeUndefined()
    expect((ran.context ?? []).join('\n')).toContain('作業中のタスクがありません')
    expect(w.files.get(`${ROOT}/.pm/log/2026-10.jsonl`)).toContain('"event":"guard.violation"')
  })

  test('.pm/ がないプロジェクトでは何もしない', async ($, on) => {
    const w = world(on)
    const ran = (await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/a.ts`, old_string: 'a', new_string: 'b' } as never)) as { context?: string[] }
    expect(ran.context).toBeUndefined()
    expect(w.writes).toEqual([])
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
    expect(context[0]).toContain('作業中 T-0001「CSV エクスポートを実装する」')
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
