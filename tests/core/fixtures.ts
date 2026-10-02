import { defaultConfig, defaultState } from '../../src/core/types.ts'
import type { Phase, Snapshot, Task } from '../../src/core/types.ts'

let counter = 0

export const task = (over: Partial<Task> & { id: string }): Task => ({
  schema: 1,
  title: `task ${over.id}`,
  kind: 'feature',
  priority: 'mid',
  status: 'todo',
  depends_on: [],
  scope: { paths: ['src/**'] },
  acceptance: ['works'],
  non_goals: [],
  created: `2026-10-02T00:00:${String(counter++ % 60).padStart(2, '0')}.000Z`,
  updated: '2026-10-02T00:00:00.000Z',
  body: '',
  ...over,
})

export const snapshot = (tasks: Task[], phase: Phase = 'alpha'): Snapshot => {
  const state = defaultState(phase)
  state.nextId = tasks.length + 1
  return { state, config: defaultConfig(), tasks }
}

export const NOW = '2026-10-02T09:00:00.000Z'
