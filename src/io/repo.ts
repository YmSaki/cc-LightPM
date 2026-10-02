// .pm/ の読み書き。$.fs と同じ形の Fs を受け取り、.pm/ の外へは書かない。

import { parseTask, serializeTask } from '../core/frontmatter.ts'
import { PHASES, SCHEMA, defaultConfig, defaultState } from '../core/types.ts'
import type { Config, LogEvent, Phase, Snapshot, State, Task } from '../core/types.ts'

export type Fs = {
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  list: (path: string) => Promise<readonly { name: string; kind: string }[]>
  exists: (path: string) => Promise<boolean>
}

export type Loaded = Snapshot & { errors: string[] }

const join = (root: string, rel: string): string => `${root.replace(/[\\/]+$/, '')}/${rel}`

/** 書き込んで読み戻す試行の最大回数。どの回も一致しなければ失敗にする。 */
const WRITE_ATTEMPTS = 3

export class Repo {
  readonly fs: Fs
  readonly root: string

  constructor(fs: Fs, root: string) {
    this.fs = fs
    this.root = root
  }

  path(rel: string): string {
    return join(this.root, rel)
  }

  async exists(): Promise<boolean> {
    return this.fs.exists(this.path('.pm/state.json'))
  }

  /** .pm/ の中だけに書く。書いた後に読み戻し、違えば書き直す。 */
  async write(rel: string, text: string): Promise<void> {
    if (!rel.startsWith('.pm/') || rel.split('/').some(seg => seg === '' || seg === '.' || seg === '..')) {
      throw new Error(`LightPM writes only inside .pm/ (refused: ${rel})`)
    }
    const path = this.path(rel)
    for (let attempt = 1; ; attempt++) {
      await this.fs.write(path, text)
      const back = await this.fs.read(path).catch(() => undefined)
      if (back === text) return
      if (attempt >= WRITE_ATTEMPTS) throw new Error(`LightPM: ${rel} の書き込みを確かめられませんでした`)
    }
  }

  async init(phase: Phase = 'alpha'): Promise<boolean> {
    if (await this.exists()) return false
    // 手で置いた config.json は残す
    if (!(await this.fs.exists(this.path('.pm/config.json')))) {
      await this.write('.pm/config.json', `${JSON.stringify(defaultConfig(), null, 2)}\n`)
    }
    await this.write('.pm/state.json', `${JSON.stringify(defaultState(phase), null, 2)}\n`)
    return true
  }

  private async readJson(rel: string): Promise<Record<string, unknown> | undefined> {
    const path = this.path(rel)
    if (!(await this.fs.exists(path))) return undefined
    const parsed: unknown = JSON.parse(await this.fs.read(path))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  }

  async load(): Promise<Loaded> {
    const errors: string[] = []
    const rawState = await this.readJson('.pm/state.json').catch(e => {
      errors.push(`.pm/state.json: ${String(e)}`)
      return undefined
    })
    const rawConfig = await this.readJson('.pm/config.json').catch(e => {
      errors.push(`.pm/config.json: ${String(e)}`)
      return undefined
    })
    const state = defaultState()
    if (rawState) {
      if (typeof rawState.phase === 'string' && (PHASES as readonly string[]).includes(rawState.phase)) state.phase = rawState.phase as Phase
      if (typeof rawState.nextId === 'number' && rawState.nextId > 0) state.nextId = Math.floor(rawState.nextId)
      if (typeof rawState.active === 'string') state.active = rawState.active
    }
    const config = defaultConfig()
    if (rawConfig?.policy && typeof rawConfig.policy === 'object') config.policy = rawConfig.policy as Config['policy']

    const tasks: Task[] = []
    const dir = this.path('.pm/tasks')
    const entries = (await this.fs.exists(dir)) ? await this.fs.list(dir) : []
    const names = entries
      .filter(e => e.kind === 'file' && /^T-\d+\.md$/.test(e.name))
      .map(e => e.name)
      .sort()
    const seen = new Set<string>()
    for (const name of names) {
      try {
        const task = parseTask(await this.fs.read(`${dir}/${name}`))
        if (`${task.id}.md` !== name) throw new Error(`id ${task.id} がファイル名と一致しません`)
        if (seen.has(task.id)) throw new Error(`id ${task.id} が重複しています`)
        seen.add(task.id)
        tasks.push(task)
      } catch (e) {
        errors.push(`.pm/tasks/${name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    // 手編集で nextId が既存の id 以下になっていたら進める（id の重複を防ぐ）
    for (const t of tasks) {
      const n = Number(t.id.slice(2))
      if (n >= state.nextId) state.nextId = n + 1
    }
    return { state, config, tasks, errors }
  }

  async saveTask(task: Task): Promise<void> {
    await this.write(`.pm/tasks/${task.id}.md`, serializeTask(task))
  }

  async saveState(state: State): Promise<void> {
    const out = { schema: SCHEMA, phase: state.phase, nextId: state.nextId, active: state.active }
    await this.write('.pm/state.json', `${JSON.stringify(out, null, 2)}\n`)
  }

  /** 監査ログに追記する。$.fs に追記がないため、読んで末尾に足して書き戻す。 */
  async appendLog(events: readonly LogEvent[], now: string, actor = 'core'): Promise<void> {
    if (events.length === 0) return
    const rel = `.pm/log/${now.slice(0, 7)}.jsonl`
    const path = this.path(rel)
    const current = (await this.fs.exists(path)) ? await this.fs.read(path) : ''
    let seq = current.split('\n').filter(l => l.trim() !== '').length
    const lines = events.map(e => {
      seq += 1
      const { event, actor: own, ...rest } = e
      return JSON.stringify({ schema: SCHEMA, ts: now, seq, actor: typeof own === 'string' ? own : actor, event, ...rest })
    })
    const base = current === '' || current.endsWith('\n') ? current : `${current}\n`
    await this.write(rel, `${base}${lines.join('\n')}\n`)
  }

  /** 監査ログをすべて読む（古い月から）。 */
  async readLog(): Promise<Record<string, unknown>[]> {
    const dir = this.path('.pm/log')
    if (!(await this.fs.exists(dir))) return []
    const files = (await this.fs.list(dir)).filter(e => /^\d{4}-\d{2}\.jsonl$/.test(e.name)).map(e => e.name).sort()
    const events: Record<string, unknown>[] = []
    for (const file of files) {
      for (const line of (await this.fs.read(`${dir}/${file}`)).split('\n')) {
        if (line.trim() === '') continue
        try {
          events.push(JSON.parse(line) as Record<string, unknown>)
        } catch {
          // 壊れた行は読み飛ばす
        }
      }
    }
    return events
  }

  /** コアの結果をまとめて書き込む。 */
  async persist(outcome: { tasks: readonly Task[]; state: State; events: readonly LogEvent[] }, now: string, stateChanged = true): Promise<void> {
    for (const task of outcome.tasks) await this.saveTask(task)
    if (stateChanged) await this.saveState(outcome.state)
    await this.appendLog(outcome.events, now)
  }
}
