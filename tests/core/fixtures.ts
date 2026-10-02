import { defaultState } from '../../src/core/types.ts'
import type { Snapshot, Task } from '../../src/core/types.ts'

let counter = 0

export const task = (over: Partial<Task> & { id: string }): Task => ({
  schema: 1,
  title: `task ${over.id}`,
  kind: 'feature',
  priority: 'mid',
  status: 'todo',
  depends_on: [],
  checklist: [{ text: 'works', done: false }],
  created: `2026-10-02T00:00:${String(counter++ % 60).padStart(2, '0')}.000Z`,
  updated: '2026-10-02T00:00:00.000Z',
  body: '',
  ...over,
})

export const snapshot = (tasks: Task[]): Snapshot => {
  const state = defaultState()
  state.nextId = tasks.length + 1
  return { state, tasks }
}

export const NOW = '2026-10-02T09:00:00.000Z'
