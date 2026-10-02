// スナップショットの作業用コピー。変更されたタスクと監査ログの出来事を集め、呼び出し側がまとめて書き込む。

import { byId } from './priority.ts'
import type { LogEvent, Snapshot, State, Task } from './types.ts'

export type Outcome<R> = { result: R; tasks: Task[]; state: State; events: LogEvent[] }

export class Draft {
  readonly tasks: Map<string, Task>
  readonly state: State
  readonly events: LogEvent[] = []
  readonly now: string
  private readonly original: Map<string, string>

  constructor(snapshot: Snapshot, now: string) {
    this.now = now
    const sorted = [...snapshot.tasks].sort(byId)
    this.tasks = new Map(sorted.map(t => [t.id, structuredClone(t)]))
    this.original = new Map(sorted.map(t => [t.id, JSON.stringify(t)]))
    this.state = structuredClone(snapshot.state)
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
